import { describe, it, expect } from 'vitest';
import {
  parseLogcatLine,
  mapLogcatPriority,
} from '../src/native/android-logcat.js';

describe('mapLogcatPriority', () => {
  it('maps priority letters to levels', () => {
    expect(mapLogcatPriority('V')).toBe('verbose');
    expect(mapLogcatPriority('D')).toBe('debug');
    expect(mapLogcatPriority('I')).toBe('info');
    expect(mapLogcatPriority('W')).toBe('warn');
    expect(mapLogcatPriority('E')).toBe('error');
    expect(mapLogcatPriority('F')).toBe('error');
    expect(mapLogcatPriority('?')).toBe('log');
  });
});

describe('parseLogcatLine', () => {
  it('parses a threadtime line', () => {
    const line = '06-04 17:32:23.072  3714  3714 I chromium: Set viewport attributes';
    const r = parseLogcatLine(line);
    expect(r).toBeDefined();
    expect(r!.level).toBe('info');
    expect(r!.tag).toBe('chromium');
    expect(r!.message).toBe('Set viewport attributes');
    // Parsed as local time → UTC ISO; milliseconds are preserved regardless of TZ.
    expect(r!.ts).toMatch(/\.072Z$/);
    expect(Number.isNaN(Date.parse(r!.ts!))).toBe(false);
  });

  it('parses an error line with a colon in the message', () => {
    const line = '06-04 17:32:23.216  3714  3800 E AppTag: Failed: status 404';
    const r = parseLogcatLine(line);
    expect(r!.level).toBe('error');
    expect(r!.tag).toBe('AppTag');
    expect(r!.message).toBe('Failed: status 404');
  });

  it('returns undefined for non-log lines', () => {
    expect(parseLogcatLine('--------- beginning of main')).toBeUndefined();
    expect(parseLogcatLine('')).toBeUndefined();
  });
});
