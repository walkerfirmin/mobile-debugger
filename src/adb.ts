/**
 * ADB helpers: enumerate Android WebView debug sockets and manage `adb forward`.
 *
 * Android System WebView exposes one Unix abstract socket per WebView process,
 * named `webview_devtools_remote_<pid>`. We discover them by scanning
 * `/proc/net/unix` on the device and forward each chosen socket to a local TCP
 * port so the rest of the tool can speak CDP over `127.0.0.1:<port>`.
 */
import { execa } from 'execa';

export interface AdbDevice {
  serial: string;
  state: string;
}

export interface WebViewSocket {
  /** PID of the owning WebView process on the device. */
  pid: number;
  /** Full abstract socket name, e.g. `webview_devtools_remote_12345`. */
  socket: string;
}

export interface ForwardHandle {
  serial: string;
  localPort: number;
  socket: string;
  remove(): Promise<void>;
}

const adbArgs = (serial: string | undefined, ...rest: string[]): string[] =>
  serial ? ['-s', serial, ...rest] : rest;

/** List attached devices via `adb devices`. */
export async function listDevices(): Promise<AdbDevice[]> {
  const { stdout } = await execa('adb', ['devices']);
  const lines = stdout.split('\n').slice(1);
  const devices: AdbDevice[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (serial && state) devices.push({ serial, state });
  }
  return devices;
}

/**
 * Enumerate WebView devtools sockets on the target device by reading
 * `/proc/net/unix` (the only reliable way short of root).
 */
export async function listWebviewSockets(serial?: string): Promise<WebViewSocket[]> {
  const { stdout } = await execa('adb', adbArgs(serial, 'shell', 'cat', '/proc/net/unix'));
  const sockets: WebViewSocket[] = [];
  // Each line has fields; the path is the last column. Abstract sockets begin with '@'
  // when surfaced via `ss`, but in /proc/net/unix they appear as `@webview_devtools_remote_<pid>`.
  const re = /@?(webview_devtools_remote_(\d+))/;
  for (const line of stdout.split('\n')) {
    const m = re.exec(line);
    if (m && m[1] && m[2]) {
      sockets.push({ socket: m[1], pid: Number(m[2]) });
    }
  }
  // Deduplicate (each socket appears in multiple kernel rows).
  const seen = new Set<string>();
  return sockets.filter((s) => (seen.has(s.socket) ? false : (seen.add(s.socket), true)));
}

/**
 * Forward `tcp:<localPort>` on the host to `localabstract:<socket>` on the device.
 * Returns a handle whose `remove()` tears the forward down.
 */
export async function forwardSocket(
  socket: string,
  localPort: number,
  serial?: string,
): Promise<ForwardHandle> {
  await execa('adb', adbArgs(serial, 'forward', `tcp:${localPort}`, `localabstract:${socket}`));
  return {
    serial: serial ?? '',
    localPort,
    socket,
    async remove() {
      try {
        await execa('adb', adbArgs(serial, 'forward', '--remove', `tcp:${localPort}`));
      } catch {
        // Best effort.
      }
    },
  };
}

/** Pick a free local TCP port without binding (relies on the kernel handing out unique
 *  ephemeral ports between calls — close enough for adb forward). */
export async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('Could not allocate free port'));
      }
    });
  });
}
