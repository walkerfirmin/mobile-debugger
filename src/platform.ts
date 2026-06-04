/**
 * Platform-agnostic acquisition of a local CDP endpoint for WebView capture.
 *
 * Android and iOS reach the same place — a `127.0.0.1:<port>` CDP-compatible
 * HTTP/WebSocket interface — by different routes:
 *   - Android: `adb forward` a `webview_devtools_remote_<pid>` socket; targets
 *     are listed at `/json/list`.
 *   - iOS: `ios-webkit-debug-proxy` bridges WebKit's inspector protocol; targets
 *     are listed at `/json`.
 *
 * {@link acquireWebTarget} hides that difference so the CLI's `targets` and
 * capture paths can stay platform-neutral.
 */
import {
  forwardSocket, listWebviewSockets, pickFreePort, type ForwardHandle,
} from './adb.js';
import { resolveIosDevice } from './ios/devices.js';
import { startIwdp, type IwdpHandle } from './ios/iwdp.js';
import type { Platform } from './types.js';

export interface WebTarget {
  /** Local TCP port exposing the CDP HTTP/WebSocket interface. */
  port: number;
  /** HTTP path of the JSON target list (`/json/list` Android, `/json` iOS). */
  jsonPath: string;
  /** Source platform, stamped onto captured records. */
  platform: Platform;
  /** Tear down forwarding / proxy. */
  remove(): Promise<void>;
}

export interface AcquireOptions {
  platform: Platform;
  /** ADB serial (Android) or device/simulator UDID (iOS). */
  device?: string;
  /** Android only: pick a specific WebView host process. */
  pid?: number;
  /** iOS only: which environment to target. */
  env: 'device' | 'simulator' | 'auto';
  /** Use an already-prepared local port; skips forwarding/proxy. */
  port?: number;
  onInfo?: (msg: string) => void;
}

async function acquireAndroid(opts: AcquireOptions): Promise<WebTarget> {
  const log = opts.onInfo ?? (() => undefined);
  if (opts.port) {
    return { port: opts.port, jsonPath: '/json/list', platform: 'android', async remove() {} };
  }
  const sockets = await listWebviewSockets(opts.device);
  if (sockets.length === 0) {
    throw new Error('No WebView sockets found. Ensure the app is debug-built and a device is connected.');
  }
  const chosen = opts.pid ? sockets.find((s) => s.pid === opts.pid) : sockets[0];
  if (!chosen) throw new Error(`No WebView with pid=${opts.pid}`);
  const port = await pickFreePort();
  const fwd: ForwardHandle = await forwardSocket(chosen.socket, port, opts.device);
  log(`forwarded tcp:${port} -> ${chosen.socket} (pid ${chosen.pid})`);
  return {
    port,
    jsonPath: '/json/list',
    platform: 'android',
    remove: () => fwd.remove(),
  };
}

async function acquireIos(opts: AcquireOptions): Promise<WebTarget> {
  if (opts.port) {
    return { port: opts.port, jsonPath: '/json', platform: 'ios', async remove() {} };
  }
  const device = await resolveIosDevice(opts.device, opts.env);
  const port = await pickFreePort();
  const iwdp: IwdpHandle = await startIwdp(device.udid, port, device.env, opts.onInfo);
  return {
    port: iwdp.port,
    jsonPath: iwdp.jsonPath,
    platform: 'ios',
    remove: () => iwdp.remove(),
  };
}

/** Acquire a local CDP endpoint for the requested platform. */
export async function acquireWebTarget(opts: AcquireOptions): Promise<WebTarget> {
  return opts.platform === 'ios' ? acquireIos(opts) : acquireAndroid(opts);
}
