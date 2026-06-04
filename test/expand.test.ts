import { describe, it, expect } from 'vitest';
import { expandRemoteObject, type RemoteObject, type CdpRuntime } from '../src/cdp/expand.js';

/**
 * Build a tiny mock CDP Runtime surface from a fixture map.
 * Each `objectId` maps to either a list of own-properties (array) or, for
 * Map/Set, a `[[Entries]]` slot.
 */
function mockRuntime(graph: Record<string, RemoteObject[]>) {
  const released: string[] = [];
  const rt: CdpRuntime = {
    async getProperties({ objectId }) {
      const props = graph[objectId] ?? [];
      return { result: props.map((value, idx) => ({ name: String(idx), value })) };
    },
    async releaseObject({ objectId }) {
      released.push(objectId);
      return undefined;
    },
  };
  return { rt, released };
}

describe('CDP expander', () => {
  it('returns primitive without an objectId', async () => {
    const { rt } = mockRuntime({});
    const r = await expandRemoteObject(rt, { type: 'string', value: 'hi' });
    expect(r).toEqual({ t: 'string', value: 'hi' });
  });

  it('walks an object graph and releases every visited objectId', async () => {
    // root = [child]; child = [{leaf}]
    const { rt, released } = mockRuntime({
      'root': [{ type: 'object', objectId: 'child' }],
      'child': [{ type: 'string', value: 'leaf' }],
    });
    const r = await expandRemoteObject(rt, { type: 'object', subtype: 'array', objectId: 'root', className: 'Array' });
    expect(r).toMatchObject({ t: 'array' });
    expect(released).toContain('root');
    expect(released).toContain('child');
  });

  it('breaks cycles', async () => {
    const { rt } = mockRuntime({
      'a': [{ type: 'object', objectId: 'b' }],
      'b': [{ type: 'object', objectId: 'a' }],
    });
    const r = await expandRemoteObject(rt, { type: 'object', objectId: 'a' });
    // Should not infinite-loop; somewhere inside we get a cycle marker.
    const json = JSON.stringify(r);
    expect(json).toContain('"cycle"');
  });

  it('respects depth cap', async () => {
    const { rt } = mockRuntime({
      'a': [{ type: 'object', objectId: 'b' }],
      'b': [{ type: 'object', objectId: 'c' }],
      'c': [{ type: 'object', objectId: 'd' }],
      'd': [{ type: 'string', value: 'leaf' }],
    });
    const r = await expandRemoteObject(rt, { type: 'object', objectId: 'a' }, { maxDepth: 1 });
    expect(JSON.stringify(r)).toContain('truncated');
  });

  it('parses error description into name/message/stack', async () => {
    const { rt } = mockRuntime({});
    const r = await expandRemoteObject(rt, {
      type: 'object', subtype: 'error', objectId: 'e',
      description: 'TypeError: x is not a function\n    at foo (a.js:1:1)',
    });
    expect(r).toMatchObject({ t: 'error', name: 'TypeError', message: 'x is not a function' });
  });
});
