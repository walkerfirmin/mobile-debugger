/**
 * CDP connection + auto-attach.
 *
 * Strategy (WebView friendly): for every locally-reachable CDP endpoint we
 * treat the JSON target-list endpoint as the source of truth for available
 * page targets. We poll it periodically; on every newly-seen target we open a
 * per-target CDP client and start a {@link CaptureSession}. This handles both
 * the main Capacitor WebView and any in-app-browser WebViews that appear later
 * (they generally surface as additional target-list entries).
 *
 * The same strategy works for Android System WebView (sockets forwarded by
 * `adb forward`, list at `/json/list`) and for iOS WebViews surfaced via
 * `ios-webkit-debug-proxy` (list at `/json`). We avoid the browser-level
 * flatten/auto-attach path because mobile WebViews are not a Chromium browser —
 * they expose only the per-page protocol — and pages are the units we want to
 * attach to anyway.
 */
import CDP from 'chrome-remote-interface';
import type { CaptureOptions, Platform } from '../types.js';
import { CaptureSession, type SessionClient, type Sink } from './capture.js';
import { freshFetch } from './http.js';

interface JsonListEntry {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface AttachOptions {
  /** Local port that forwards to a device WebView socket (or iwdp port). */
  port: number;
  /** Filter targets: 'main' = first page only; 'all' = every page; or an explicit id. */
  target: 'main' | 'all' | string;
  /** Poll interval for the target list in ms. */
  pollMs?: number;
  /**
   * HTTP path of the JSON target list. Android System WebView uses
   * `/json/list` (default); `ios-webkit-debug-proxy` uses `/json`.
   */
  jsonPath?: string;
  /** Device platform; stamped onto every captured record. */
  platform?: Platform;
  capture: CaptureOptions;
  sink: Sink;
  /** Logger called with progress messages (one-line strings). */
  onInfo?: (msg: string) => void;
}

export interface AttachHandle {
  /** Stop polling and detach all sessions. */
  stop(): Promise<void>;
}

async function fetchTargets(port: number, jsonPath: string): Promise<JsonListEntry[]> {
  const res = await freshFetch(`http://127.0.0.1:${port}${jsonPath}`);
  if (!res.ok) throw new Error(`${jsonPath} ${res.status}`);
  const all = (await res.json()) as JsonListEntry[];
  return all.filter((e) => (e.type ?? 'page') === 'page');
}

/** Wraps a CRI client to match {@link SessionClient}. */
function wrap(client: CDP.Client): SessionClient {
  return {
    send: (method, params) => (client as unknown as { send: (m: string, p?: unknown) => Promise<unknown> }).send(method, params),
    on: (event, handler) => {
      // CRI exposes events as `client.on('Domain.event', handler)`.
      (client as unknown as { on: (e: string, h: (p: unknown) => void) => void }).on(event, handler);
    },
  };
}

export async function attach(opts: AttachOptions): Promise<AttachHandle> {
  const pollMs = opts.pollMs ?? 1500;
  const jsonPath = opts.jsonPath ?? '/json/list';
  const seen = new Map<string, CDP.Client>();
  let stopped = false;
  let mainAttached = false;
  let consecutivePollFailures = 0;
  const MAX_POLL_FAILURES = 5;
  let timer: NodeJS.Timeout | undefined;

  const log = opts.onInfo ?? (() => undefined);

  async function tick(): Promise<void> {
    if (stopped) return;
    let entries: JsonListEntry[] = [];
    try {
      entries = await fetchTargets(opts.port, jsonPath);
      consecutivePollFailures = 0;
    } catch (err) {
      consecutivePollFailures++;
      log(`poll failed (${consecutivePollFailures}/${MAX_POLL_FAILURES}): ${(err as Error).message}`);
      if (consecutivePollFailures >= MAX_POLL_FAILURES) {
        log('giving up on /json/list polling (forwarded socket appears dead)');
        stopped = true;
        if (timer) clearInterval(timer);
      }
      return;
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      // Apply target filter.
      if (opts.target === 'main') {
        if (mainAttached) continue;
      } else if (opts.target !== 'all') {
        if (entry.id !== opts.target) continue;
      }

      try {
        // Prefer webSocketDebuggerUrl from /json/list AND local: true so that
        // chrome-remote-interface does NOT issue extra HTTP requests
        // (/json/version, /json/protocol). Android WebView's HTTP server is
        // unstable under repeated connections, so we limit ourselves to one
        // /json/list per poll and then connect to the WS directly.
        const client = entry.webSocketDebuggerUrl
          ? await CDP({ target: entry.webSocketDebuggerUrl, local: true })
          : await CDP({ port: opts.port, target: entry.id, local: true });
        seen.set(entry.id, client);
        const labelIndex = seen.size === 1 ? 'main' : `iab:${seen.size - 1}`;
        const session = new CaptureSession(
          wrap(client),
          {
            targetId: entry.id,
            targetLabel: labelIndex,
            url: entry.url,
            platform: opts.platform,
          },
          opts.capture,
          opts.sink,
        );
        await session.start();
        log(`attached: ${labelIndex} ${entry.url ?? ''}`);
        if (opts.target === 'main') mainAttached = true;
        client.on('disconnect', () => {
          seen.delete(entry.id);
          log(`detached: ${labelIndex}`);
        });
      } catch (err) {
        log(`attach failed for ${entry.id}: ${(err as Error).message}`);
      }
    }
  }

  // Kick off and schedule.
  await tick();
  timer = setInterval(() => { void tick(); }, pollMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await Promise.all(
        [...seen.values()].map((c) => (c.close ? c.close() : Promise.resolve()).catch(() => undefined)),
      );
      seen.clear();
    },
  };
}
