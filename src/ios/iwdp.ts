/**
 * iOS WebView bridge via `ios-webkit-debug-proxy` (iwdp).
 *
 * iOS WebViews speak the WebKit Remote Inspector protocol, not the Chrome
 * DevTools Protocol. `ios-webkit-debug-proxy` translates between the two and
 * exposes a CDP-compatible HTTP/WebSocket interface — a list of page targets at
 * `http://127.0.0.1:<port>/json` plus per-target `webSocketDebuggerUrl`s — which
 * is close enough to Android's `/json/list` that the rest of the capture
 * pipeline is reused unchanged.
 *
 * We spawn iwdp bound to a single device UDID and a fixed local port, then wait
 * for the JSON endpoint to come up before handing back a {@link IwdpHandle}.
 */
import { spawn } from 'node:child_process';
import { freshFetch } from '../cdp/http.js';

export interface IwdpHandle {
  /** Local TCP port the proxy's JSON/WebSocket interface listens on. */
  port: number;
  /** HTTP path of the target list (`/json` for iwdp). */
  jsonPath: string;
  /** Stop the proxy. */
  remove(): Promise<void>;
}

const IWDP_BIN = 'ios_webkit_debug_proxy';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the iwdp JSON endpoint until it responds or the timeout elapses. */
async function waitForJson(port: number, jsonPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await freshFetch(`http://127.0.0.1:${port}${jsonPath}`);
      if (res.ok) return;
      lastErr = new Error(`${jsonPath} ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(250);
  }
  throw new Error(
    `ios-webkit-debug-proxy did not become ready on port ${port}: ${(lastErr as Error)?.message ?? 'timeout'}`,
  );
}

/**
 * Spawn `ios-webkit-debug-proxy` for a single device and wait until its JSON
 * target-list endpoint is reachable.
 *
 * @param udid    Device/simulator UDID to bind to.
 * @param port    Local TCP port for the proxy's JSON/WebSocket interface.
 * @param onInfo  Optional progress logger.
 */
export async function startIwdp(
  udid: string,
  port: number,
  onInfo?: (msg: string) => void,
): Promise<IwdpHandle> {
  const log = onInfo ?? (() => undefined);
  // `-c <udid>:<port>` binds a single device to a fixed port; `--no-frontend`
  // disables the bundled HTML UI (we only need the JSON/WS interface).
  const args = ['-c', `${udid}:${port}`, '--no-frontend'];

  const child = spawn(IWDP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let spawnError: Error | undefined;
  child.on('error', (err: NodeJS.ErrnoException) => {
    spawnError =
      err.code === 'ENOENT'
        ? new Error(
            'ios-webkit-debug-proxy not found on PATH. Install it ' +
              '(e.g. `brew install ios-webkit-debug-proxy`).',
          )
        : err;
  });
  child.stderr?.on('data', (d: Buffer) => log(`iwdp: ${d.toString().trim()}`));

  const remove = async (): Promise<void> => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  };

  try {
    await waitForJson(port, '/json', 10_000);
  } catch (err) {
    await remove();
    throw spawnError ?? err;
  }
  if (spawnError) {
    await remove();
    throw spawnError;
  }

  log(`ios-webkit-debug-proxy on 127.0.0.1:${port} -> ${udid}`);
  return { port, jsonPath: '/json', remove };
}
