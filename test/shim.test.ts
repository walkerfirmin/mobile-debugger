import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildConsoleShimSource, DUMP_MARKER } from '../src/inject/console-shim.js';

/**
 * Run the shim source inside a Node `vm` with a fake `window` + `console` so we
 * can drive it as if it were running in a page and inspect the marker payloads
 * it emits to console.debug.
 */
function harness(opts?: { maxDepth?: number; maxStringLen?: number; maxEntries?: number }) {
  const captured: Array<{ marker: string; payload: unknown }> = [];
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    console: {
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: (marker: string, json: string) => {
        if (marker === DUMP_MARKER) captured.push({ marker, payload: JSON.parse(json) });
      },
      trace: () => undefined,
      table: () => undefined,
      dir: () => undefined,
      group: () => undefined,
      groupCollapsed: () => undefined,
      assert: () => undefined,
    },
    ArrayBuffer,
    DataView,
    Promise,
    Map,
    Set,
    Date,
    RegExp,
    Error,
  };
  const ctx = runInNewContext(
    buildConsoleShimSource({
      maxDepth: opts?.maxDepth ?? 10,
      maxStringLen: opts?.maxStringLen ?? 10_000,
      maxEntries: opts?.maxEntries ?? 200,
    }) +
      ';this',
    sandbox,
  ) as Record<string, unknown>;
  return {
    log(...args: unknown[]) { (ctx.console as { log: (...a: unknown[]) => void }).log(...args); },
    error(...args: unknown[]) { (ctx.console as { error: (...a: unknown[]) => void }).error(...args); },
    captured,
  };
}

describe('console shim', () => {
  it('serialises primitives and tags level', () => {
    const h = harness();
    h.log('hello', 1, true, null);
    expect(h.captured).toHaveLength(1);
    const p = h.captured[0]!.payload as { level: string; args: Array<{ t: string; value?: unknown }> };
    expect(p.level).toBe('log');
    expect(p.args.map((a) => a.t)).toEqual(['string', 'primitive', 'primitive', 'primitive']);
    expect(p.args[0]).toMatchObject({ t: 'string', value: 'hello' });
  });

  it('handles circular refs', () => {
    const h = harness();
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    h.log(a);
    const arg = (h.captured[0]!.payload as { args: Array<{ t: string; entries: Record<string, { t: string }> }> }).args[0]!;
    expect(arg.t).toBe('object');
    expect(arg.entries['self']!.t).toBe('cycle');
  });

  it('caps depth', () => {
    const h = harness({ maxDepth: 2 });
    h.log({ a: { b: { c: { d: 1 } } } });
    const root = (h.captured[0]!.payload as { args: unknown[] }).args[0] as { entries: Record<string, unknown> };
    // Walk down: root.entries.a.entries.b should be either truncated or contain a deeper truncation.
    const bWrapper = (root.entries['a'] as { entries: Record<string, unknown> }).entries['b'] as { t: string };
    // At depth 2 we should hit truncated marker before reaching `d`.
    expect(JSON.stringify(bWrapper)).toContain('truncated');
  });

  it('truncates long strings', () => {
    const h = harness({ maxStringLen: 10 });
    h.log('x'.repeat(50));
    const a = (h.captured[0]!.payload as { args: Array<{ value: string; truncated?: boolean }> }).args[0]!;
    expect(a.value.length).toBe(10);
    expect(a.truncated).toBe(true);
  });

  it('serialises Error including cause', () => {
    const h = harness();
    const inner = { foo: 'bar' };
    h.error(new Error('boom', { cause: inner }));
    const arg = (h.captured[0]!.payload as { args: Array<{ t: string; message: string; cause?: { entries: Record<string, { value: string }> } }> }).args[0]!;
    expect(arg.t).toBe('error');
    expect(arg.message).toBe('boom');
    expect(arg.cause!.entries['foo']!.value).toBe('bar');
  });

  it('serialises Map and Set', () => {
    const h = harness();
    h.log(new Map([['k', 'v']]), new Set([1, 2]));
    const args = (h.captured[0]!.payload as { args: Array<{ t: string }> }).args;
    expect(args[0]!.t).toBe('map');
    expect(args[1]!.t).toBe('set');
  });

  it('handles BigInt', () => {
    const h = harness();
    h.log(BigInt('12345678901234567890'));
    const a = (h.captured[0]!.payload as { args: Array<{ t: string; value: string }> }).args[0]!;
    expect(a.t).toBe('bigint');
    expect(a.value).toBe('12345678901234567890');
  });

  it('caps collection entries', () => {
    const h = harness({ maxEntries: 3 });
    h.log([1, 2, 3, 4, 5]);
    const a = (h.captured[0]!.payload as { args: Array<{ t: string; entries: unknown[]; truncated?: boolean }> }).args[0]!;
    expect(a.entries.length).toBe(3);
    expect(a.truncated).toBe(true);
  });
});
