/**
 * Per-session capture pipeline.
 *
 * One {@link CaptureSession} is created per attached CDP target. It enables the
 * `Runtime`, `Log`, and `Page` domains, injects the page-side console shim
 * (when configured), normalises every relevant event into a {@link LogRecord},
 * and forwards it to the shared writer/sink.
 */
import type { LogLevel, LogRecord, SerializedValue, CaptureOptions, Platform } from '../types.js';
import { buildConsoleShimSource } from '../inject/console-shim.js';
import { parseMarker } from '../inject/parse-marker.js';
import { expandRemoteObject, type RemoteObject } from './expand.js';

/** Minimal shape of a CDP session client we depend on. */
export interface SessionClient {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
}

export interface SessionContext {
  targetId: string;
  targetLabel: string;
  /** Optional URL hint (updated on Page.frameNavigated). */
  url?: string;
  /** Device platform this session is attached to. */
  platform?: Platform;
}

export interface Sink {
  write(rec: LogRecord): void;
}

interface RuntimeArg extends RemoteObject { }

/** Map a CDP `Runtime.consoleAPICalled` `type` to our LogLevel. */
function mapConsoleType(type: string): LogLevel {
  switch (type) {
    case 'log': case 'info': case 'warn': case 'error': case 'debug':
    case 'trace': case 'table': case 'dir': case 'group': case 'groupCollapsed':
    case 'groupEnd': case 'assert': case 'count': case 'timeEnd':
      return type as LogLevel;
    case 'startGroup': return 'group';
    case 'startGroupCollapsed': return 'groupCollapsed';
    case 'endGroup': return 'groupEnd';
    case 'clear': return 'log';
    default: return 'log';
  }
}

/** Map a CDP `Log.entryAdded` level to our LogLevel. */
function mapLogLevel(level: string): LogLevel {
  switch (level) {
    case 'verbose': return 'verbose';
    case 'info': return 'info';
    case 'warning': return 'warn';
    case 'error': return 'error';
    default: return 'log';
  }
}

function applyRedaction(values: SerializedValue[], redact: RegExp | undefined): SerializedValue[] {
  if (!redact) return values;
  const walk = (v: SerializedValue): SerializedValue => {
    if (v.t === 'string') return { ...v, value: v.value.replace(redact, '***') };
    if (v.t === 'array') return { ...v, entries: v.entries.map(walk) };
    if (v.t === 'set') return { ...v, entries: v.entries.map(walk) };
    if (v.t === 'object') {
      const out: Record<string, SerializedValue> = {};
      for (const [k, val] of Object.entries(v.entries)) out[k] = walk(val);
      return { ...v, entries: out };
    }
    if (v.t === 'map') return { ...v, entries: v.entries.map(([k, val]) => [walk(k), walk(val)] as [SerializedValue, SerializedValue]) };
    if (v.t === 'error') return { ...v, cause: v.cause ? walk(v.cause) : undefined };
    return v;
  };
  return values.map(walk);
}

export class CaptureSession {
  private context: SessionContext;
  constructor(
    private readonly client: SessionClient,
    context: SessionContext,
    private readonly options: CaptureOptions,
    private readonly sink: Sink,
  ) {
    this.context = { ...context };
  }

  async start(): Promise<void> {
    // Wire handlers BEFORE enabling domains so we don't drop the first event.
    this.client.on('Runtime.consoleAPICalled', (params: unknown) => {
      void this.onConsoleAPI(params as ConsoleAPIParams).catch(() => undefined);
    });
    this.client.on('Runtime.exceptionThrown', (params: unknown) => {
      void this.onException(params as ExceptionParams).catch(() => undefined);
    });
    this.client.on('Log.entryAdded', (params: unknown) => {
      this.onLogEntry(params as LogEntryParams);
    });
    this.client.on('Page.frameNavigated', (params: unknown) => {
      const p = params as { frame?: { url?: string; parentId?: string } };
      if (p.frame && !p.frame.parentId && typeof p.frame.url === 'string') {
        this.context.url = p.frame.url;
      }
    });

    // Inject the shim BEFORE enabling Runtime (so it loads on every navigation).
    if (this.options.inject) {
      const source = buildConsoleShimSource({
        maxDepth: this.options.maxDepth,
        maxStringLen: this.options.maxStringLen,
        maxEntries: this.options.maxEntries,
      });
      try {
        await this.client.send('Page.addScriptToEvaluateOnNewDocument', { source });
      } catch { /* Page domain may not be available on some targets */ }
      // Also inject into the current context (best-effort).
      try {
        await this.client.send('Runtime.evaluate', { expression: source, includeCommandLineAPI: false });
      } catch { /* ignore */ }
    }

    await this.safeSend('Runtime.enable');
    await this.safeSend('Log.enable');
    await this.safeSend('Page.enable');
  }

  private async safeSend(method: string, params?: unknown): Promise<void> {
    try { await this.client.send(method, params); } catch { /* domain may not exist */ }
  }

  private async onConsoleAPI(params: ConsoleAPIParams): Promise<void> {
    const args = params.args ?? [];
    const marker = parseMarker(args as Array<{ type?: string; value?: unknown }>);
    let level: LogLevel;
    let serialised: SerializedValue[];
    let source: 'console' | 'shim';

    if (marker) {
      level = marker.level;
      serialised = marker.args;
      source = 'shim';
    } else {
      level = mapConsoleType(params.type ?? 'log');
      source = 'console';
      serialised = await Promise.all(
        args.map((a) => this.expand(a as RuntimeArg)),
      );
    }

    const stack = formatStack(params.stackTrace);
    this.emit({
      level,
      source,
      args: applyRedaction(serialised, this.options.redact),
      stack,
      executionContextId: params.executionContextId,
      ts: params.timestamp ? new Date(params.timestamp).toISOString() : new Date().toISOString(),
    });
  }

  private async onException(params: ExceptionParams): Promise<void> {
    const detail = params.exceptionDetails;
    const exc = detail?.exception;
    const args: SerializedValue[] = [];
    if (exc) {
      args.push(await this.expand(exc as RuntimeArg));
    } else if (detail?.text) {
      args.push({ t: 'string', value: detail.text });
    }
    const stack = formatStack(detail?.stackTrace);
    this.emit({
      level: 'error',
      source: 'exception',
      args: applyRedaction(args, this.options.redact),
      stack,
      executionContextId: detail?.executionContextId,
      ts: detail?.timestamp ? new Date(detail.timestamp).toISOString() : new Date().toISOString(),
    });
  }

  private onLogEntry(params: LogEntryParams): void {
    const e = params.entry;
    if (!e) return;
    const args: SerializedValue[] = [{ t: 'string', value: String(e.text ?? '') }];
    if (e.url) args.push({ t: 'string', value: `[${e.url}${e.lineNumber !== undefined ? ':' + e.lineNumber : ''}]` });
    this.emit({
      level: mapLogLevel(e.level ?? 'log'),
      source: 'log',
      args: applyRedaction(args, this.options.redact),
      stack: formatStack(e.stackTrace),
      ts: e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString(),
    });
  }

  private async expand(arg: RuntimeArg): Promise<SerializedValue> {
    return expandRemoteObject(
      {
        getProperties: (p) => this.client.send('Runtime.getProperties', p) as Promise<{
          result: Array<{ name: string; value?: RemoteObject; enumerable?: boolean }>;
          internalProperties?: Array<{ name: string; value?: RemoteObject }>;
        }>,
        releaseObject: (p) => this.client.send('Runtime.releaseObject', p),
      },
      arg,
      {
        maxDepth: this.options.maxDepth,
        maxStringLen: this.options.maxStringLen,
        maxEntries: this.options.maxEntries,
      },
    );
  }

  private emit(partial: Omit<LogRecord, 'targetId' | 'targetLabel' | 'url'>): void {
    this.sink.write({
      targetId: this.context.targetId,
      targetLabel: this.context.targetLabel,
      url: this.context.url,
      platform: this.context.platform,
      channel: 'web',
      ...partial,
    });
  }
}

interface ConsoleAPIParams {
  type?: string;
  args?: RemoteObject[];
  stackTrace?: StackTrace;
  executionContextId?: number;
  timestamp?: number;
}

interface ExceptionParams {
  exceptionDetails?: {
    text?: string;
    exception?: RemoteObject;
    stackTrace?: StackTrace;
    executionContextId?: number;
    timestamp?: number;
  };
}

interface LogEntryParams {
  entry?: {
    text?: string;
    level?: string;
    url?: string;
    lineNumber?: number;
    stackTrace?: StackTrace;
    timestamp?: number;
  };
}

interface StackTrace {
  callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }>;
  parent?: StackTrace;
}

function formatStack(s: StackTrace | undefined): string | undefined {
  if (!s?.callFrames?.length) return undefined;
  const lines: string[] = [];
  let cur: StackTrace | undefined = s;
  while (cur?.callFrames) {
    for (const f of cur.callFrames) {
      const fn = f.functionName || '<anonymous>';
      const loc = `${f.url ?? ''}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1}`;
      lines.push(`  at ${fn} (${loc})`);
    }
    cur = cur.parent;
  }
  return lines.join('\n');
}
