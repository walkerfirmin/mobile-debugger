/**
 * Shared types for the dump-logs CLI.
 *
 * The capture pipeline normalises every CDP event (`Runtime.consoleAPICalled`,
 * `Runtime.exceptionThrown`, `Log.entryAdded`) into a single {@link LogRecord}
 * which is what the NDJSON writer and HTML viewer consume.
 */

/** Tagged union representing a deeply-serialised JS value. */
export type SerializedValue =
  | { t: 'primitive'; value: string | number | boolean | null }
  | { t: 'undefined' }
  | { t: 'bigint'; value: string }
  | { t: 'symbol'; description: string | null }
  | { t: 'string'; value: string; truncated?: boolean }
  | { t: 'function'; name: string; source?: string }
  | { t: 'error'; name: string; message: string; stack?: string; cause?: SerializedValue }
  | { t: 'date'; iso: string }
  | { t: 'regexp'; source: string; flags: string }
  | { t: 'array'; entries: SerializedValue[]; truncated?: boolean }
  | { t: 'object'; entries: Record<string, SerializedValue>; className?: string; truncated?: boolean }
  | { t: 'map'; entries: Array<[SerializedValue, SerializedValue]>; truncated?: boolean }
  | { t: 'set'; entries: SerializedValue[]; truncated?: boolean }
  | { t: 'node'; tagName: string; id?: string; classes?: string[]; outerHTML?: string }
  | { t: 'typedarray'; className: string; length: number; preview?: number[] }
  | { t: 'promise'; state?: 'pending' | 'fulfilled' | 'rejected' }
  | { t: 'cycle' }
  | { t: 'truncated'; reason: 'depth' | 'length' }
  | { t: 'unknown'; description?: string };

/** Source of a captured event. */
export type LogSource =
  | 'console'        // Runtime.consoleAPICalled (or shim re-emit)
  | 'exception'      // Runtime.exceptionThrown
  | 'log'            // Log.entryAdded (browser-level: network/security/etc.)
  | 'shim'           // Synthetic record from the page-side shim
  | 'native';        // Device-side native log (Android logcat / iOS os_log)

/** Which device platform a record originated from. */
export type Platform = 'android' | 'ios';

/** Whether a record came from a WebView (web) or the native runtime. */
export type LogChannel = 'web' | 'native';

/** Console level (`console.log` etc) or exception/log severity. */
export type LogLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace'
  | 'table'
  | 'dir'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'assert'
  | 'count'
  | 'timeEnd'
  | 'verbose';

/** A single normalised event written to NDJSON. */
export interface LogRecord {
  /** ISO-8601 timestamp on the host. */
  ts: string;
  /** CDP target id this record originated from (main vs. in-app-browser). */
  targetId: string;
  /** A short human label for the target (`main`, `iab:<n>`). */
  targetLabel: string;
  /** Page URL at the time the event was captured (best-effort). */
  url?: string;
  /** Browsing source of the event. */
  source: LogSource;
  /** Severity / API name. */
  level: LogLevel;
  /** Deeply serialised arguments (always at least one entry, possibly an empty string). */
  args: SerializedValue[];
  /** Captured stack trace (oldest call first, formatted). */
  stack?: string;
  /** CDP execution context id (main world vs isolated worlds). */
  executionContextId?: number;
  /** Device platform this record came from (`android` | `ios`). */
  platform?: Platform;
  /** Web (WebView console) vs native (device log) channel. */
  channel?: LogChannel;
}

/** Options controlling the per-session capture pipeline. */
export interface CaptureOptions {
  /** Hard cap on object/array nesting depth before emitting `{t:'truncated', reason:'depth'}`. */
  maxDepth: number;
  /** Hard cap on string length before truncating. */
  maxStringLen: number;
  /** Hard cap on entries per array/object/map/set before truncating. */
  maxEntries: number;
  /** When true, inject the page-side shim via `Page.addScriptToEvaluateOnNewDocument`. */
  inject: boolean;
  /** When true, also enable Network domain (off by default — focus is console). */
  enableNetwork: boolean;
  /** Optional regex applied to serialised string values; matches are masked with `***`. */
  redact?: RegExp;
}

/** CLI-level options shared by `live` and `dump` subcommands. */
export interface CliOptions extends CaptureOptions {
  /** Target device platform. */
  platform: Platform;
  /** Which environment to target for iOS (physical `device` vs `simulator`). */
  env: 'device' | 'simulator' | 'auto';
  device?: string;
  pid?: number;
  port: number;
  target: 'main' | 'all' | string;
  out: string;
  /** Capture WebView (web) console logs. */
  web: boolean;
  /** Capture native (device) logs. */
  native: boolean;
  /** Native-log filter: app bundle id (iOS) or package name (Android). */
  bundleId?: string;
  /** Native-log filter: process name. */
  processName?: string;
  /** Only used by `dump` subcommand. */
  durationMs?: number;
  /** When true, also stream pretty-printed records to stdout. */
  tty: boolean;
}
