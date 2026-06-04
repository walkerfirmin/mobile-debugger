import { describe, it, expect } from 'vitest';
import {
  parseSimctlJsonLine,
  parseSyslogLine,
  mapOsLogType,
  mapSyslogSeverity,
} from '../src/native/ios-syslog.js';

describe('mapOsLogType', () => {
  it('maps os_log message types to levels', () => {
    expect(mapOsLogType('Debug')).toBe('debug');
    expect(mapOsLogType('Info')).toBe('info');
    expect(mapOsLogType('Default')).toBe('log');
    expect(mapOsLogType('Error')).toBe('error');
    expect(mapOsLogType('Fault')).toBe('error');
    expect(mapOsLogType(undefined)).toBe('log');
  });
});

describe('mapSyslogSeverity', () => {
  it('maps syslog tokens to levels', () => {
    expect(mapSyslogSeverity('Notice')).toBe('log');
    expect(mapSyslogSeverity('Warning')).toBe('warn');
    expect(mapSyslogSeverity('Error')).toBe('error');
    expect(mapSyslogSeverity('Critical')).toBe('error');
  });
});

describe('parseSimctlJsonLine', () => {
  it('parses an ndjson log line', () => {
    const obj = {
      timestamp: '2026-06-04 17:32:23.072000-0700',
      messageType: 'Error',
      eventMessage: 'Failed to load resource',
      process: 'TheStandard',
    };
    const r = parseSimctlJsonLine(JSON.stringify(obj));
    expect(r).toBeDefined();
    expect(r!.level).toBe('error');
    expect(r!.tag).toBe('TheStandard');
    expect(r!.message).toBe('Failed to load resource');
    // Stamp carries an explicit -0700 offset, so the UTC instant is deterministic.
    expect(r!.ts).toBe('2026-06-05T00:32:23.072Z');
  });

  it('handles a trailing comma and process image path', () => {
    const obj = { messageType: 'Default', eventMessage: 'hi', processImagePath: '/usr/bin/foo' };
    const r = parseSimctlJsonLine(JSON.stringify(obj) + ',');
    expect(r!.tag).toBe('foo');
    expect(r!.level).toBe('log');
  });

  it('ignores array brackets and bad JSON', () => {
    expect(parseSimctlJsonLine('[')).toBeUndefined();
    expect(parseSimctlJsonLine(']')).toBeUndefined();
    expect(parseSimctlJsonLine('{not json')).toBeUndefined();
  });
});

describe('parseSyslogLine', () => {
  it('parses an idevicesyslog line', () => {
    const line = 'Jun  4 17:32:23 iPhone TheStandard[1234] <Notice>: Angular is running';
    const r = parseSyslogLine(line);
    expect(r).toBeDefined();
    expect(r!.level).toBe('log');
    expect(r!.tag).toBe('TheStandard');
    expect(r!.message).toBe('Angular is running');
  });

  it('returns undefined for unmatched lines', () => {
    expect(parseSyslogLine('garbage')).toBeUndefined();
  });
});
