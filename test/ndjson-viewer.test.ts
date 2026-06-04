import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonWriter } from '../src/output/ndjson.js';
import { buildViewer } from '../src/output/viewer.js';
import type { LogRecord } from '../src/types.js';

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-06-03T12:00:00.000Z',
    targetId: 'T1',
    targetLabel: 'main',
    level: 'log',
    source: 'console',
    args: [{ t: 'string', value: 'hi' }],
    ...over,
  };
}

describe('NdjsonWriter + viewer', () => {
  it('writes one line per record and the viewer inlines them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dumplogs-'));
    const w = new NdjsonWriter({ outDir: dir, basename: 'session-x' });
    w.write(rec());
    w.write(rec({ level: 'error', args: [{ t: 'string', value: '</script>injected' }] }));
    await w.close();

    const out = readFileSync(w.files()[0]!, 'utf8');
    expect(out.split('\n').filter(Boolean)).toHaveLength(2);

    const html = buildViewer({ ndjsonFiles: w.files(), outFile: join(dir, 'session-x.html') });
    const content = readFileSync(html, 'utf8');
    // </script must have been escaped so the host script tag is not closed.
    expect(content.includes('</script>injected')).toBe(false);
    expect(content.includes('<\\/script>injected')).toBe(true);
  });
});
