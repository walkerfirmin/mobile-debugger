import { createReadStream, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOST = '127.0.0.1';

function loadAppHtml(): string {
  const candidates = [
    resolve(__dirname, '../../viewer/app.html'),
    resolve(__dirname, '../viewer/app.html'),
    resolve(process.cwd(), 'viewer/app.html'),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // Try next path.
    }
  }
  throw new Error('viewer/app.html not found');
}

function isAllowedHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return (
    host === '' ||
    host === HOST ||
    host.startsWith(`${HOST}:`) ||
    host === 'localhost' ||
    host.startsWith('localhost:')
  );
}

function sendNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function sendBadRequest(res: ServerResponse): void {
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Bad request');
}

async function tryListen(server: Server, port: number): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const onError = (err: unknown): void => {
      server.off('listening', onListening);
      rejectPort(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectPort(new Error('Could not determine listener address'));
        return;
      }
      resolvePort(addr.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

export interface ViewerServer {
  url: string;
  close: () => Promise<void>;
}

export async function startViewerServer(filePath: string): Promise<ViewerServer> {
  await access(filePath);
  const appHtml = loadAppHtml();

  const server = createServer((req, res) => {
    if (!isAllowedHost(req)) {
      sendBadRequest(res);
      return;
    }

    if (!req.url || req.method !== 'GET') {
      sendNotFound(res);
      return;
    }

    const path = req.url.split('?')[0] ?? '/';
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(appHtml);
      return;
    }

    if (path === '/data') {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end('Failed to read NDJSON file');
      });
      stream.pipe(res);
      return;
    }

    sendNotFound(res);
  });

  let port: number | undefined;
  const preferredPorts = [9300, 9301, 9302, 9303, 9304, 9305, 9306, 9307, 9308, 9309, 0];
  for (const candidate of preferredPorts) {
    try {
      port = await tryListen(server, candidate);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        throw err;
      }
    }
  }

  if (!port) {
    throw new Error('Failed to start viewer server');
  }

  return {
    url: `http://${HOST}:${port}/`,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      });
    },
  };
}
