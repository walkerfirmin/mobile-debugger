/**
 * Detect and parse `__DUMPLOGS__` marker events emitted by the page-side shim.
 *
 * A `Runtime.consoleAPICalled` event whose first argument's `value` equals the
 * marker and second argument is a JSON string carries the shim's structured
 * payload. The host prefers this over expanding the raw RemoteObjects.
 */
import { DUMP_MARKER } from './console-shim.js';
import type { LogLevel, SerializedValue } from '../types.js';

export interface ParsedMarker {
  level: LogLevel;
  args: SerializedValue[];
}

interface RawArg {
  type?: string;
  value?: unknown;
}

/** Returns the parsed payload when `args` is a marker pair, otherwise `null`. */
export function parseMarker(args: readonly RawArg[] | undefined): ParsedMarker | null {
  if (!args || args.length < 2) return null;
  const first = args[0];
  const second = args[1];
  if (!first || !second) return null;
  if (first.type !== 'string' || first.value !== DUMP_MARKER) return null;
  if (second.type !== 'string' || typeof second.value !== 'string') return null;
  try {
    const parsed = JSON.parse(second.value) as { level?: string; args?: SerializedValue[] };
    if (!parsed || !Array.isArray(parsed.args)) return null;
    return {
      level: (parsed.level as LogLevel) ?? 'log',
      args: parsed.args,
    };
  } catch {
    return null;
  }
}
