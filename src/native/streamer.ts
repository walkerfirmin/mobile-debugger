/**
 * Native (device-side) log streaming.
 *
 * Where the CDP pipeline captures WebView `console.*` output, native streamers
 * capture the host app's platform logs: Android `logcat` and iOS `os_log` /
 * `NSLog`. Each line is normalised into the same {@link LogRecord} shape used by
 * the web pipeline (with `channel: 'native'`) so both feed one NDJSON file and
 * one HTML viewer.
 */
import type { LogLevel, LogRecord, Platform } from '../types.js';
import type { Sink } from '../cdp/capture.js';

export interface NativeStreamer {
  /** Begin streaming; resolves once the underlying process has been spawned. */
  start(): Promise<void>;
  /** Stop streaming and release the underlying process. */
  stop(): Promise<void>;
}

/** A parsed native log line before it becomes a {@link LogRecord}. */
export interface NativeLine {
  level: LogLevel;
  /** Best-effort source label (process / tag), used as the target label. */
  tag: string;
  /** The human-readable message. */
  message: string;
  /** Optional ISO timestamp parsed from the line; host time is used otherwise. */
  ts?: string;
}

/** Build a {@link LogRecord} from a parsed native line. */
export function nativeLineToRecord(line: NativeLine, platform: Platform): LogRecord {
  return {
    ts: line.ts ?? new Date().toISOString(),
    targetId: `native:${platform}`,
    targetLabel: line.tag ? `native:${line.tag}` : 'native',
    source: 'native',
    channel: 'native',
    platform,
    level: line.level,
    args: [{ t: 'string', value: line.message }],
  };
}

/** Forward a parsed native line to a sink as a normalised record. */
export function emitNativeLine(sink: Sink, line: NativeLine, platform: Platform): void {
  sink.write(nativeLineToRecord(line, platform));
}
