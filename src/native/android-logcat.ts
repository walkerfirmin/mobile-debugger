/**
 * Android native log streaming via `adb logcat`.
 *
 * We run `adb logcat -v threadtime` and parse each line into a {@link NativeLine}.
 * The threadtime format is stable and includes a priority letter we map to our
 * {@link LogLevel}. Capture can be scoped to a single app by PID.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { LogLevel } from '../types.js';
import type { Sink } from '../cdp/capture.js';
import { emitNativeLine, type NativeLine, type NativeStreamer } from './streamer.js';

/** Map an Android logcat priority letter to a {@link LogLevel}. */
export function mapLogcatPriority(p: string): LogLevel {
  switch (p) {
    case 'V': return 'verbose';
    case 'D': return 'debug';
    case 'I': return 'info';
    case 'W': return 'warn';
    case 'E': return 'error';
    case 'F': return 'error'; // Fatal -> error
    default: return 'log';
  }
}

// threadtime: `MM-DD HH:MM:SS.mmm  PID  TID P TAG: message`
const THREADTIME_RE =
  /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?):\s?(.*)$/;

/**
 * Parse a single `adb logcat -v threadtime` line. Returns `undefined` for lines
 * that aren't log entries (e.g. `--------- beginning of main`).
 */
export function parseLogcatLine(line: string): NativeLine | undefined {
  const m = THREADTIME_RE.exec(line);
  if (!m) return undefined;
  const [, when, , , prio, tag, message] = m;
  return {
    level: mapLogcatPriority(prio!),
    tag: tag!.trim(),
    message: message ?? '',
    ts: toIso(when!),
  };
}

/** Convert a logcat `MM-DD HH:MM:SS.mmm` stamp to ISO using the current year. */
function toIso(stamp: string): string | undefined {
  const m = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) return undefined;
  const [, mo, da, hh, mm, ss, ms] = m;
  const year = new Date().getFullYear();
  const d = new Date(year, Number(mo) - 1, Number(da), Number(hh), Number(mm), Number(ss), Number(ms));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface LogcatOptions {
  sink: Sink;
  /** ADB device serial. */
  device?: string;
  /** Restrict to a single app process id. */
  pid?: number;
  onInfo?: (msg: string) => void;
}

/** Android `adb logcat` streamer. */
export class LogcatStreamer implements NativeStreamer {
  private child?: ChildProcess;
  private buffer = '';

  constructor(private opts: LogcatOptions) {}

  async start(): Promise<void> {
    const args: string[] = [];
    if (this.opts.device) args.push('-s', this.opts.device);
    args.push('logcat', '-v', 'threadtime');
    if (this.opts.pid) args.push('--pid', String(this.opts.pid));

    const child = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const log = this.opts.onInfo ?? (() => undefined);
    child.on('error', (err: NodeJS.ErrnoException) => {
      log(
        err.code === 'ENOENT'
          ? 'adb not found on PATH (Android Platform Tools) — native logcat disabled'
          : `logcat error: ${err.message}`,
      );
    });
    child.stderr?.on('data', (d: Buffer) => log(`logcat: ${d.toString().trim()}`));
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    log(`streaming adb logcat${this.opts.pid ? ` (pid ${this.opts.pid})` : ''}`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      const parsed = parseLogcatLine(line);
      if (parsed) emitNativeLine(this.opts.sink, parsed, 'android');
    }
  }

  async stop(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
  }
}
