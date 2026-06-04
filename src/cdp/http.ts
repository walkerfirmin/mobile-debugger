/**
 * Workaround for Android System WebView's embedded DevTools HTTP server.
 *
 * That server only supports **one connection at a time** and mishandles HTTP
 * keep-alive — once a client opens a keep-alive connection, subsequent
 * connections (even on fresh TCP sockets) come back as "Empty reply from
 * server" until the first connection's keep-alive timeout elapses.
 *
 * Node's global `fetch` (undici) forces keep-alive even when the caller sets
 * `Connection: close`, so we bypass it entirely and use the bare `http`
 * module with `agent: false` to guarantee a fresh connection per request and
 * an explicit `Connection: close` header that the WebView server honors.
 */
import { request } from 'node:http';

export interface FreshResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export async function freshFetch(url: string): Promise<FreshResponse> {
  return await new Promise<FreshResponse>((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        agent: false, // disable connection pooling
        headers: { Connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
            async text() { return body; },
            async json<T>() { return JSON.parse(body) as T; },
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('request timeout'));
    });
    req.end();
  });
}
