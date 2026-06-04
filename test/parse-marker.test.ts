import { describe, it, expect } from 'vitest';
import { parseMarker } from '../src/inject/parse-marker.js';
import { DUMP_MARKER } from '../src/inject/console-shim.js';

describe('parseMarker', () => {
  it('returns null when args do not start with the marker', () => {
    expect(parseMarker([{ type: 'string', value: 'hello' }, { type: 'string', value: '{}' }])).toBeNull();
  });

  it('parses a valid marker pair', () => {
    const payload = JSON.stringify({ level: 'warn', args: [{ t: 'primitive', value: 1 }] });
    const r = parseMarker([
      { type: 'string', value: DUMP_MARKER },
      { type: 'string', value: payload },
    ]);
    expect(r).toEqual({ level: 'warn', args: [{ t: 'primitive', value: 1 }] });
  });

  it('returns null on bad JSON', () => {
    const r = parseMarker([
      { type: 'string', value: DUMP_MARKER },
      { type: 'string', value: '{not json' },
    ]);
    expect(r).toBeNull();
  });
});
