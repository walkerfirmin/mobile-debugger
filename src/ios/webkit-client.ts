/**
 * Modern WebKit (iOS 16.4+) inspector adapter.
 *
 * `ios-webkit-debug-proxy` exposes a per-page WebSocket, but on recent iOS the
 * underlying WebInspector protocol uses the `Target` domain for *indirection*:
 * after connecting, the page does NOT accept direct domain commands. Instead it
 * emits `Target.targetCreated` events, and every real command must be wrapped:
 *
 *   { method: "Target.sendMessageToTarget",
 *     params: { targetId, message: JSON.stringify({ id, method, params }) } }
 *
 * Responses and events come back wrapped in `Target.dispatchMessageFromTarget`
 * (`params.targetId`, `params.message` = JSON string of the inner CDP message).
 * `ios-webkit-debug-proxy` 1.9.x does not unwrap this, so we do it here.
 *
 * This adapter presents the same minimal surface the rest of the code expects
 * from a CDP client (`send` / `on` / `close`) and transparently:
 *   - tracks the page target id (e.g. `page-8`),
 *   - wraps outgoing commands and matches their responses,
 *   - unwraps inbound events,
 *   - auto-enables the legacy `Console` domain, and
 *   - translates WebKit `Console.messageAdded` events into the
 *     `Runtime.consoleAPICalled` shape the capture pipeline consumes.
 */
import WebSocket from 'ws';

type Handler = (params: unknown) => void;

export interface WebKitClient {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: Handler): void;
  close(): Promise<void>;
}

interface InnerMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

interface TargetInfo {
  targetId: string;
  type?: string;
}

/** Inner-command response timeout (ms). Prevents hangs on swallowed errors. */
const SEND_TIMEOUT_MS = 8000;
/** How long to wait for the page target to appear before resolving anyway. */
const PAGE_TARGET_GRACE_MS = 6000;

export async function createWebKitClient(
  wsUrl: string,
  onInfo: (msg: string) => void = () => undefined,
): Promise<WebKitClient> {
  const ws = new WebSocket(wsUrl);
  const handlers = new Map<string, Set<Handler>>();
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >();
  const earlyQueue: Array<() => void> = [];

  let outerId = 0;
  let innerId = 0;
  let pageTargetId: string | undefined;
  let consoleEnabled = false;

  function emit(event: string, params: unknown): void {
    const hs = handlers.get(event);
    if (!hs) return;
    for (const h of hs) {
      try {
        h(params);
      } catch {
        /* handler errors must not break the dispatch loop */
      }
    }
  }

  function rawSend(method: string, params: unknown): void {
    ws.send(JSON.stringify({ id: ++outerId, method, params }));
  }

  function dispatchInner(inner: InnerMessage): void {
    if (inner.id != null && pending.has(inner.id)) {
      const p = pending.get(inner.id)!;
      pending.delete(inner.id);
      clearTimeout(p.timer);
      if (inner.error) p.reject(new Error(inner.error.message ?? 'WebKit command failed'));
      else p.resolve(inner.result);
      return;
    }
    if (inner.method) {
      // Translate the legacy WebKit Console domain into the modern shape the
      // capture pipeline already understands.
      if (inner.method === 'Console.messageAdded') {
        emit('Runtime.consoleAPICalled', toConsoleApi(inner.params));
        return;
      }
      emit(inner.method, inner.params);
    }
  }

  function onPageTarget(targetId: string): void {
    pageTargetId = targetId;
    onInfo(`webkit: page target ${targetId}`);
    // Ensure console events flow even though the capture pipeline only enables
    // Runtime/Log/Page (the WebKit Console domain is what actually emits logs).
    if (!consoleEnabled) {
      consoleEnabled = true;
      void sendInner('Console.enable').catch(() => undefined);
    }
    for (const fn of earlyQueue.splice(0)) fn();
  }

  ws.on('message', (data: WebSocket.RawData) => {
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.method) {
      case 'Target.targetCreated': {
        const t = msg.params?.targetInfo as TargetInfo | undefined;
        if (t?.targetId && (t.type === 'page' || !pageTargetId)) {
          if (t.type === 'page' || !pageTargetId) onPageTarget(t.targetId);
        }
        return;
      }
      case 'Target.targetDestroyed': {
        const id = msg.params?.targetId as string | undefined;
        if (id && id === pageTargetId) pageTargetId = undefined;
        return;
      }
      case 'Target.dispatchMessageFromTarget': {
        const raw = msg.params?.message;
        if (typeof raw !== 'string') return;
        let inner: InnerMessage;
        try {
          inner = JSON.parse(raw);
        } catch {
          return;
        }
        dispatchInner(inner);
        return;
      }
      default:
        // Top-level responses to our Target.* envelopes carry no useful payload.
        return;
    }
  });

  function sendInner(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const doSend = (): void => {
        if (!pageTargetId) {
          reject(new Error('WebKit page target unavailable'));
          return;
        }
        const iid = ++innerId;
        const timer = setTimeout(() => {
          pending.delete(iid);
          reject(new Error(`WebKit command timed out: ${method}`));
        }, SEND_TIMEOUT_MS);
        timer.unref?.();
        pending.set(iid, { resolve, reject, timer });
        rawSend('Target.sendMessageToTarget', {
          targetId: pageTargetId,
          message: JSON.stringify({ id: iid, method, params: params ?? {} }),
        });
      };
      if (pageTargetId) doSend();
      else earlyQueue.push(doSend);
    });
  }

  // Open the socket; the page emits Target.targetCreated shortly after.
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error): void => reject(err);
    ws.once('error', onErr);
    ws.once('open', () => {
      ws.removeListener('error', onErr);
      resolve();
    });
  });
  ws.on('close', () => emit('disconnect', undefined));
  ws.on('error', () => undefined);

  // Wait for the page target (best-effort) so the first commands aren't queued.
  if (!pageTargetId) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, PAGE_TARGET_GRACE_MS);
      t.unref?.();
      const poll = setInterval(() => {
        if (pageTargetId) {
          clearTimeout(t);
          clearInterval(poll);
          resolve();
        }
      }, 50);
      poll.unref?.();
    });
  }

  return {
    send: sendInner,
    on: (event, handler) => {
      let s = handlers.get(event);
      if (!s) {
        s = new Set();
        handlers.set(event, s);
      }
      s.add(handler);
    },
    close: async () => {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

interface WebKitConsoleMessage {
  source?: string;
  level?: string;
  type?: string;
  text?: string;
  parameters?: unknown[];
  stackTrace?: unknown;
  timestamp?: number;
  url?: string;
  line?: number;
}

/**
 * Translate a WebKit `Console.messageAdded` payload into the
 * `Runtime.consoleAPICalled` shape (`{ type, args, stackTrace, timestamp }`).
 *
 * When the page-side shim is active each user `console.*` call arrives here as a
 * `__DUMPLOGS__` marker pair (two string parameters), which the capture
 * pipeline's `parseMarker` reconstructs with full fidelity. Plain messages fall
 * back to their raw RemoteObject `parameters` (or the `text` when absent).
 */
function toConsoleApi(params: unknown): {
  type: string;
  args: unknown[];
  stackTrace?: unknown;
  timestamp?: number;
} {
  const m = (params as { message?: WebKitConsoleMessage } | undefined)?.message ?? {};
  const args =
    Array.isArray(m.parameters) && m.parameters.length > 0
      ? m.parameters
      : [{ type: 'string', value: String(m.text ?? '') }];
  // WebKit reports a console `type` (e.g. 'log', 'dir', 'trace') and a `level`
  // ('log' | 'info' | 'warning' | 'error' | 'debug'). Prefer the level since it
  // best matches the console method the user called.
  const level = m.level === 'warning' ? 'warn' : m.level;
  return {
    type: level ?? m.type ?? 'log',
    args,
    stackTrace: m.stackTrace,
    timestamp: m.timestamp,
  };
}
