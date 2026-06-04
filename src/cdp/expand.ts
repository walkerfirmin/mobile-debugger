/**
 * CDP fallback expander.
 *
 * Used when the page-side shim is unavailable (e.g. an event fired before
 * injection completed, or `--no-inject` is set). Recursively walks a
 * `Runtime.RemoteObject` graph using `Runtime.getProperties`, with a depth cap,
 * a per-walk cycle guard keyed on `objectId`, and best-effort `releaseObject`
 * cleanup so we don't leak references in the inspected page.
 */
import type { SerializedValue } from '../types.js';

/** Subset of the `Runtime.RemoteObject` shape we use. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: { properties?: Array<{ name: string; type: string; value?: string; subtype?: string }> };
}

/** Subset of the CDP client surface we need. */
export interface CdpRuntime {
  getProperties(params: {
    objectId: string;
    ownProperties?: boolean;
    accessorPropertiesOnly?: boolean;
    generatePreview?: boolean;
  }): Promise<{
    result: Array<{ name: string; value?: RemoteObject; enumerable?: boolean }>;
    internalProperties?: Array<{ name: string; value?: RemoteObject }>;
  }>;
  releaseObject(params: { objectId: string }): Promise<unknown>;
}

export interface ExpandOptions {
  maxDepth: number;
  maxStringLen: number;
  maxEntries: number;
}

const DEFAULT_OPTS: ExpandOptions = { maxDepth: 10, maxStringLen: 10_000, maxEntries: 200 };

/** Expand a top-level RemoteObject into a SerializedValue tree. */
export async function expandRemoteObject(
  runtime: CdpRuntime,
  obj: RemoteObject,
  options: Partial<ExpandOptions> = {},
): Promise<SerializedValue> {
  const opts = { ...DEFAULT_OPTS, ...options };
  const visited = new Set<string>();
  const released = new Set<string>();
  try {
    return await walk(runtime, obj, 0, visited, released, opts);
  } finally {
    // Release everything we touched.
    await Promise.all(
      [...released].map((id) => runtime.releaseObject({ objectId: id }).catch(() => undefined)),
    );
  }
}

async function walk(
  runtime: CdpRuntime,
  obj: RemoteObject,
  depth: number,
  visited: Set<string>,
  released: Set<string>,
  opts: ExpandOptions,
): Promise<SerializedValue> {
  if (depth > opts.maxDepth) return { t: 'truncated', reason: 'depth' };

  // Primitives carried by-value (no objectId).
  if (obj.objectId === undefined) {
    return materialisePrimitive(obj, opts);
  }

  if (visited.has(obj.objectId)) return { t: 'cycle' };
  visited.add(obj.objectId);
  released.add(obj.objectId);

  // Special subtypes.
  switch (obj.subtype) {
    case 'null':
      return { t: 'primitive', value: null };
    case 'date':
      return { t: 'date', iso: typeof obj.description === 'string' ? obj.description : 'Invalid Date' };
    case 'regexp': {
      const desc = obj.description ?? '';
      const m = /^\/(.*)\/([gimsuy]*)$/.exec(desc);
      return m && m[1] !== undefined && m[2] !== undefined
        ? { t: 'regexp', source: m[1], flags: m[2] }
        : { t: 'regexp', source: desc, flags: '' };
    }
    case 'error':
      return await expandError(runtime, obj, depth, visited, released, opts);
    case 'map':
      return await expandMapOrSet(runtime, obj, depth, visited, released, opts, 'map');
    case 'set':
      return await expandMapOrSet(runtime, obj, depth, visited, released, opts, 'set');
    case 'node':
      return {
        t: 'node',
        tagName: (obj.description ?? '').split(/[#.\s>]/)[0]?.toLowerCase() || 'node',
      };
    case 'typedarray': {
      const lenMatch = /\((\d+)\)/.exec(obj.description ?? '');
      return {
        t: 'typedarray',
        className: obj.className ?? 'TypedArray',
        length: lenMatch && lenMatch[1] ? Number(lenMatch[1]) : 0,
      };
    }
    case 'promise':
      return { t: 'promise' };
  }

  // Function.
  if (obj.type === 'function') {
    return {
      t: 'function',
      name: obj.className ?? 'Function',
      source: typeof obj.description === 'string' ? clip(obj.description, 500) : undefined,
    };
  }

  // Array vs plain object.
  const isArray = obj.subtype === 'array' || obj.className === 'Array';
  return await expandObjectLike(runtime, obj, depth, visited, released, opts, isArray);
}

function materialisePrimitive(obj: RemoteObject, opts: ExpandOptions): SerializedValue {
  switch (obj.type) {
    case 'undefined':
      return { t: 'undefined' };
    case 'string': {
      const s = String(obj.value ?? '');
      return s.length > opts.maxStringLen
        ? { t: 'string', value: s.slice(0, opts.maxStringLen), truncated: true }
        : { t: 'string', value: s };
    }
    case 'number':
      if (typeof obj.value === 'number') return { t: 'primitive', value: obj.value };
      // unserializable: NaN/Infinity/-Infinity/-0
      return { t: 'unknown', description: obj.unserializableValue };
    case 'boolean':
      return { t: 'primitive', value: Boolean(obj.value) };
    case 'bigint':
      return { t: 'bigint', value: String(obj.unserializableValue ?? obj.description ?? '0') };
    case 'symbol':
      return { t: 'symbol', description: obj.description ?? null };
    case 'object':
      if (obj.subtype === 'null') return { t: 'primitive', value: null };
      return { t: 'unknown', description: obj.description };
    default:
      return { t: 'unknown', description: obj.description };
  }
}

async function expandObjectLike(
  runtime: CdpRuntime,
  obj: RemoteObject,
  depth: number,
  visited: Set<string>,
  released: Set<string>,
  opts: ExpandOptions,
  asArray: boolean,
): Promise<SerializedValue> {
  if (!obj.objectId) {
    return asArray ? { t: 'array', entries: [] } : { t: 'object', entries: {} };
  }
  let props;
  try {
    props = await runtime.getProperties({
      objectId: obj.objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false,
    });
  } catch {
    return { t: 'unknown', description: obj.description };
  }
  if (asArray) {
    const entries: SerializedValue[] = [];
    let truncated = false;
    let i = 0;
    for (const p of props.result) {
      // Skip non-index keys like `length`.
      if (p.name === 'length' || !/^\d+$/.test(p.name)) continue;
      if (i++ >= opts.maxEntries) { truncated = true; break; }
      entries.push(p.value ? await walk(runtime, p.value, depth + 1, visited, released, opts) : { t: 'undefined' });
    }
    return truncated ? { t: 'array', entries, truncated: true } : { t: 'array', entries };
  }
  const out: Record<string, SerializedValue> = {};
  let truncated = false;
  let i = 0;
  for (const p of props.result) {
    if (i++ >= opts.maxEntries) { truncated = true; break; }
    out[p.name] = p.value ? await walk(runtime, p.value, depth + 1, visited, released, opts) : { t: 'undefined' };
  }
  const result: SerializedValue = { t: 'object', entries: out };
  if (obj.className && obj.className !== 'Object') (result as { className?: string }).className = obj.className;
  if (truncated) (result as { truncated?: boolean }).truncated = true;
  return result;
}

async function expandError(
  runtime: CdpRuntime,
  obj: RemoteObject,
  depth: number,
  visited: Set<string>,
  released: Set<string>,
  opts: ExpandOptions,
): Promise<SerializedValue> {
  const desc = obj.description ?? '';
  // First line is "Name: message"; remaining lines are the stack.
  const firstNl = desc.indexOf('\n');
  const head = firstNl >= 0 ? desc.slice(0, firstNl) : desc;
  const stack = firstNl >= 0 ? desc.slice(firstNl + 1) : undefined;
  const colon = head.indexOf(':');
  const name = colon > 0 ? head.slice(0, colon) : 'Error';
  const message = colon > 0 ? head.slice(colon + 2) : head;
  const result: { t: 'error'; name: string; message: string; stack?: string; cause?: SerializedValue } = {
    t: 'error', name, message,
  };
  if (stack) result.stack = stack;
  // Try to read `.cause` if present.
  if (obj.objectId) {
    try {
      const props = await runtime.getProperties({ objectId: obj.objectId, ownProperties: true });
      const cause = props.result.find((p) => p.name === 'cause');
      if (cause?.value) {
        result.cause = await walk(runtime, cause.value, depth + 1, visited, released, opts);
      }
    } catch {
      // ignore
    }
  }
  return result;
}

async function expandMapOrSet(
  runtime: CdpRuntime,
  obj: RemoteObject,
  depth: number,
  visited: Set<string>,
  released: Set<string>,
  opts: ExpandOptions,
  kind: 'map' | 'set',
): Promise<SerializedValue> {
  // Map/Set entries are exposed via internal `[[Entries]]` slot.
  if (!obj.objectId) {
    return kind === 'map' ? { t: 'map', entries: [] } : { t: 'set', entries: [] };
  }
  try {
    const props = await runtime.getProperties({ objectId: obj.objectId, ownProperties: false });
    const internal = (props.internalProperties ?? []).find((p) => p.name === '[[Entries]]');
    if (!internal?.value?.objectId) {
      return kind === 'map' ? { t: 'map', entries: [] } : { t: 'set', entries: [] };
    }
    released.add(internal.value.objectId);
    const entriesProps = await runtime.getProperties({ objectId: internal.value.objectId, ownProperties: true });
    if (kind === 'map') {
      const out: Array<[SerializedValue, SerializedValue]> = [];
      let truncated = false;
      let i = 0;
      for (const p of entriesProps.result) {
        if (!p.value?.objectId) continue;
        if (!/^\d+$/.test(p.name)) continue;
        if (i++ >= opts.maxEntries) { truncated = true; break; }
        released.add(p.value.objectId);
        const pair = await runtime.getProperties({ objectId: p.value.objectId, ownProperties: true });
        const k = pair.result.find((x) => x.name === 'key')?.value;
        const v = pair.result.find((x) => x.name === 'value')?.value;
        out.push([
          k ? await walk(runtime, k, depth + 1, visited, released, opts) : { t: 'undefined' },
          v ? await walk(runtime, v, depth + 1, visited, released, opts) : { t: 'undefined' },
        ]);
      }
      return truncated ? { t: 'map', entries: out, truncated: true } : { t: 'map', entries: out };
    } else {
      const out: SerializedValue[] = [];
      let truncated = false;
      let i = 0;
      for (const p of entriesProps.result) {
        if (!p.value) continue;
        if (!/^\d+$/.test(p.name)) continue;
        if (i++ >= opts.maxEntries) { truncated = true; break; }
        // Set entries expose `value`.
        if (p.value.objectId) {
          released.add(p.value.objectId);
          const sub = await runtime.getProperties({ objectId: p.value.objectId, ownProperties: true });
          const v = sub.result.find((x) => x.name === 'value')?.value;
          out.push(v ? await walk(runtime, v, depth + 1, visited, released, opts) : { t: 'undefined' });
        } else {
          out.push(await walk(runtime, p.value, depth + 1, visited, released, opts));
        }
      }
      return truncated ? { t: 'set', entries: out, truncated: true } : { t: 'set', entries: out };
    }
  } catch {
    return kind === 'map' ? { t: 'map', entries: [] } : { t: 'set', entries: [] };
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
