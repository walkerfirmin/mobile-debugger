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
import { execa } from 'execa';
import { pickFreePort } from '../adb.js';
import { freshFetch } from '../cdp/http.js';
import type { IosEnv } from './devices.js';

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

/**
 * Locate the iOS Simulator's `webinspectord_sim` unix socket.
 *
 * Modern simulators (iOS 17+) no longer expose the legacy TCP port (27753) that
 * `ios-webkit-debug-proxy` defaults to; they only serve a unix domain socket
 * owned by a per-runtime `launchd_sim` process. We enumerate those sockets via
 * `lsof` and, when several simulators are booted, match the right one by the
 * `SIMULATOR_UDID` in the owning process environment.
 */
async function findSimulatorWebInspectorSocket(udid: string): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execa('lsof', ['-aUc', 'launchd_sim'], { reject: false }));
  } catch {
    return undefined;
  }
  const candidates: Array<{ pid: string; path: string }> = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes('webinspectord_sim.socket')) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[1];
    const path = parts[parts.length - 1];
    if (pid && path) candidates.push({ pid, path });
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0]!.path;
  // Multiple booted simulators: match by SIMULATOR_UDID in the process env.
  for (const c of candidates) {
    try {
      const { stdout: env } = await execa('ps', ['eww', '-o', 'command=', '-p', c.pid], {
        reject: false,
      });
      if (env.includes(`SIMULATOR_UDID=${udid}`)) return c.path;
    } catch {
      /* fall through to default */
    }
  }
  return candidates[0]!.path;
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
 * @param env     Whether the target is a physical `device` or a `simulator`.
 * @param onInfo  Optional progress logger.
 */
export async function startIwdp(
  udid: string,
  port: number,
  env: IosEnv,
  onInfo?: (msg: string) => void,
): Promise<IwdpHandle> {
  const log = onInfo ?? (() => undefined);
  // `--no-frontend` disables the bundled HTML UI (we only need the JSON/WS
  // interface).
  let args: string[];
  if (env === 'simulator') {
    // Simulators are not reachable over usbmuxd, so `-c <udid>:<port>` cannot
    // bind them. Instead we point iwdp at the simulator's webinspectord unix
    // socket and pin the (single) simulated device to a fixed port. `null:` is
    // the device-list port; `:<port>-<port>` pins the device to exactly `port`.
    const sock = await findSimulatorWebInspectorSocket(udid);
    if (!sock) {
      throw new Error(
        'Could not find the iOS Simulator Web Inspector socket. Ensure the app ' +
          'is running with an inspectable WebView (WKWebView.isInspectable = true ' +
          'on iOS 16.4+) and that a booted simulator is active.',
      );
    }
    const listPort = await pickFreePort();
    args = ['-c', `null:${listPort},:${port}-${port}`, '-s', `unix:${sock}`, '--no-frontend'];
    log(`simulator web inspector socket: ${sock}`);
  } else {
    // `-c <udid>:<port>` binds a single physical device to a fixed port.
    args = ['-c', `${udid}:${port}`, '--no-frontend'];
  }

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
