/**
 * Generate a self-contained HTML viewer from one or more NDJSON files.
 *
 * The viewer template is read from `viewer/template.html` at runtime (relative to
 * the package install root). The placeholder `__NDJSON__` is replaced with the
 * concatenated NDJSON content. We escape `</script` to prevent the inlined data
 * from terminating the surrounding `<script type="application/x-ndjson">` tag.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Locate the viewer template whether running from `dist/` (packaged) or `src/` (dev). */
function findTemplate(): string {
  const candidates = [
    resolve(__dirname, '../../viewer/template.html'), // dist/output/viewer.js -> repo root
    resolve(__dirname, '../viewer/template.html'),    // src/output/viewer.ts in tsx
    resolve(process.cwd(), 'viewer/template.html'),
  ];
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8'); } catch { /* try next */ }
  }
  throw new Error('viewer/template.html not found');
}

export interface BuildViewerOptions {
  ndjsonFiles: readonly string[];
  outFile: string;
}

export function buildViewer({ ndjsonFiles, outFile }: BuildViewerOptions): string {
  const template = findTemplate();
  const ndjson = ndjsonFiles
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n')
    // Prevent `</script>` inside the data from terminating the host <script> tag.
    .replace(/<\/script/gi, '<\\/script');
  const html = template.replace('__NDJSON__', ndjson);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, 'utf8');
  return outFile;
}

export { findTemplate as _findTemplateForTest };

/** For dev builds, also expose where to look so callers can resolve paths uniformly. */
export const __viewerDir = join(__dirname, '..', '..', 'viewer');
