/**
 * NDJSON writer with periodic fsync and best-effort size rotation.
 */
import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { fsync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LogRecord } from '../types.js';

export interface NdjsonWriterOptions {
  /** Directory for output files. Created if missing. */
  outDir: string;
  /** Base filename (without extension). */
  basename: string;
  /** Rotate when current file exceeds this many bytes. */
  rotateBytes?: number;
  /** Flush+fsync interval in ms. */
  flushIntervalMs?: number;
}

export class NdjsonWriter {
  private stream!: WriteStream;
  private currentPath!: string;
  private partIndex = 0;
  private bytesWritten = 0;
  private readonly rotateBytes: number;
  private readonly flushTimer: NodeJS.Timeout;
  private readonly paths: string[] = [];

  constructor(private readonly opts: NdjsonWriterOptions) {
    this.rotateBytes = opts.rotateBytes ?? 256 * 1024 * 1024;
    mkdirSync(opts.outDir, { recursive: true });
    this.openNext();
    this.flushTimer = setInterval(() => this.flushSync(), opts.flushIntervalMs ?? 2000);
    this.flushTimer.unref();
  }

  private openNext(): void {
    const suffix = this.partIndex === 0 ? '' : `.part${this.partIndex}`;
    this.currentPath = join(this.opts.outDir, `${this.opts.basename}${suffix}.ndjson`);
    mkdirSync(dirname(this.currentPath), { recursive: true });
    this.stream = createWriteStream(this.currentPath, { flags: 'a' });
    this.bytesWritten = 0;
    this.paths.push(this.currentPath);
    try { this.bytesWritten = statSync(this.currentPath).size; } catch { /* new file */ }
    this.partIndex++;
  }

  write(rec: LogRecord): void {
    const line = JSON.stringify(rec) + '\n';
    this.stream.write(line);
    this.bytesWritten += Buffer.byteLength(line, 'utf8');
    if (this.bytesWritten >= this.rotateBytes) {
      this.stream.end();
      this.openNext();
    }
  }

  /** Best-effort flush + fsync of the current file. */
  flushSync(): void {
    const fd = (this.stream as unknown as { fd?: number }).fd;
    if (typeof fd === 'number') {
      fsync(fd, () => undefined);
    }
  }

  /** All paths written during the session (for the viewer to pick up). */
  files(): readonly string[] {
    return this.paths;
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}
