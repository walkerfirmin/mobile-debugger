/**
 * iOS native log streaming.
 *
 * Two backends, selected by environment:
 *   - Simulator: `xcrun simctl spawn <udid> log stream --style ndjson` — each
 *     line is a JSON object (`messageType`, `eventMessage`, `process`, …).
 *   - Physical device: `idevicesyslog -u <udid>` (libimobiledevice) — classic
 *     syslog text lines (`<Notice>`, `<Error>`, …).
 *
 * Both are parsed into the shared {@link NativeLine} shape and emitted as
 * native-channel {@link LogRecord}s.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { LogLevel } from '../types.js';
import type { Sink } from '../cdp/capture.js';
import type { IosEnv } from '../ios/devices.js';
import { emitNativeLine, type NativeLine, type NativeStreamer } from './streamer.js';

/** Map an iOS `os_log` messageType to a {@link LogLevel}. */
export function mapOsLogType(type: string | undefined): LogLevel {
  switch ((type ?? '').toLowerCase()) {
    case 'debug': return 'debug';
    case 'info': return 'info';
    case 'default': return 'log';
    case 'error': return 'error';
    case 'fault': return 'error';
    default: return 'log';
  }
}

/** Map a syslog severity token (`<Notice>`, `<Error>`, …) to a {@link LogLevel}. */
export function mapSyslogSeverity(token: string | undefined): LogLevel {
  switch ((token ?? '').toLowerCase()) {
    case 'debug': return 'debug';
    case 'info': return 'info';
    case 'notice': return 'log';
    case 'warning': return 'warn';
    case 'error': return 'error';
    case 'critical': case 'fault': return 'error';
    default: return 'log';
  }
}

interface SimctlLogJson {
  timestamp?: string;
  messageType?: string;
  eventMessage?: string;
  processImagePath?: string;
  process?: string;
  subsystem?: string;
}

/** Parse one simulator `log stream --style ndjson` line. */
export function parseSimctlJsonLine(line: string): NativeLine | undefined {
  const t = line.trim();
  if (!t || t === '[' || t === ']' || t === ',') return undefined;
  const json = t.endsWith(',') ? t.slice(0, -1) : t;
  let obj: SimctlLogJson;
  try {
    obj = JSON.parse(json) as SimctlLogJson;
  } catch {
    return undefined;
  }
  if (obj.eventMessage === undefined) return undefined;
  const proc = obj.process ?? basename(obj.processImagePath) ?? obj.subsystem ?? '';
  return {
    level: mapOsLogType(obj.messageType),
    tag: proc,
    message: obj.eventMessage,
    ts: obj.timestamp ? toIso(obj.timestamp) : undefined,
  };
}

// `Jun  4 17:32:23 Name Process[123] <Notice>: message`
const SYSLOG_RE = /^\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+(.+?)\[\d+\]\s+<(\w+)>:\s?(.*)$/;

/** Parse one `idevicesyslog` text line. */
export function parseSyslogLine(line: string): NativeLine | undefined {
  const m = SYSLOG_RE.exec(line);
  if (!m) return undefined;
  const [, proc, severity, message] = m;
  return {
    level: mapSyslogSeverity(severity),
    tag: (proc ?? '').trim(),
    message: message ?? '',
  };
}

function basename(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parts = p.split('/');
  return parts[parts.length - 1] || undefined;
}

function toIso(stamp: string): string | undefined {
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface IosSyslogOptions {
  sink: Sink;
  udid: string;
  env: IosEnv;
  /** Filter to a process name (os_log `process`/syslog process field). */
  processName?: string;
  /** Filter to an app bundle id (used to build a simulator predicate). */
  bundleId?: string;
  onInfo?: (msg: string) => void;
}

/** iOS native log streamer (simulator via simctl, device via idevicesyslog). */
export class IosSyslogStreamer implements NativeStreamer {
  private child?: ChildProcess;
  private buffer = '';

  constructor(private opts: IosSyslogOptions) {}

  async start(): Promise<void> {
    const log = this.opts.onInfo ?? (() => undefined);
    const { bin, args } = this.command();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        log(
          this.opts.env === 'simulator'
            ? 'xcrun not found — install Xcode Command Line Tools; native logs disabled'
            : 'idevicesyslog not found — install libimobiledevice; native logs disabled',
        );
      } else {
        log(`native log error: ${err.message}`);
      }
    });
    child.stderr?.on('data', (d: Buffer) => log(`native: ${d.toString().trim()}`));
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    log(`streaming iOS native logs (${this.opts.env})`);
  }

  private command(): { bin: string; args: string[] } {
    if (this.opts.env === 'simulator') {
      const args = ['simctl', 'spawn', this.opts.udid, 'log', 'stream', '--style', 'ndjson', '--level', 'debug'];
      const predicate = this.predicate();
      if (predicate) args.push('--predicate', predicate);
      return { bin: 'xcrun', args };
    }
    const args = ['-u', this.opts.udid];
    if (this.opts.processName) args.push('-p', this.opts.processName);
    return { bin: 'idevicesyslog', args };
  }

  private predicate(): string | undefined {
    if (this.opts.processName) return `process == "${this.opts.processName}"`;
    if (this.opts.bundleId) return `subsystem == "${this.opts.bundleId}"`;
    return undefined;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      const parsed =
        this.opts.env === 'simulator' ? parseSimctlJsonLine(line) : parseSyslogLine(line);
      if (parsed) emitNativeLine(this.opts.sink, parsed, 'ios');
    }
  }

  async stop(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
  }
}
