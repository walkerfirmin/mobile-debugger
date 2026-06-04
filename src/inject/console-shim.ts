/**
 * Page-side console shim.
 *
 * This file exports a single string, {@link CONSOLE_SHIM_SOURCE}, which is an
 * IIFE injected into every frame via CDP `Page.addScriptToEvaluateOnNewDocument`
 * (and `Runtime.evaluate` for already-running contexts).
 *
 * The shim wraps every `console.*` API and emits a structured marker event of
 * the form
 *
 *   console.debug('__DUMPLOGS__', '<json-payload>')
 *
 * which the host recognises and prefers over the raw RemoteObject args. The
 * original console call is also forwarded so DevTools UI behaviour is preserved.
 *
 * The serialiser handles: circular refs, Error+cause chains, Map, Set, Date,
 * RegExp, BigInt, Symbol, Function, DOM nodes, TypedArrays, and Promises. It
 * caps depth, string length, and entries-per-collection.
 */

export const DUMP_MARKER = '__DUMPLOGS__';

/**
 * Build the IIFE source. Defaults can be overridden at injection time so the
 * CLI flags propagate into the shim.
 */
export function buildConsoleShimSource(opts: {
  maxDepth: number;
  maxStringLen: number;
  maxEntries: number;
} = { maxDepth: 10, maxStringLen: 10_000, maxEntries: 200 }): string {
  return `
(function dumplogsShim(){
  if (window.__DUMPLOGS_INSTALLED__) return;
  window.__DUMPLOGS_INSTALLED__ = true;
  var MAX_DEPTH = ${opts.maxDepth};
  var MAX_STRLEN = ${opts.maxStringLen};
  var MAX_ENTRIES = ${opts.maxEntries};
  var MARKER = ${JSON.stringify(DUMP_MARKER)};

  function clipString(s){
    if (typeof s !== 'string') return s;
    if (s.length <= MAX_STRLEN) return { t:'string', value:s };
    return { t:'string', value:s.slice(0, MAX_STRLEN), truncated:true };
  }

  function serialize(value, depth, seen){
    if (depth > MAX_DEPTH) return { t:'truncated', reason:'depth' };
    if (value === null) return { t:'primitive', value:null };
    var typ = typeof value;
    if (typ === 'undefined') return { t:'undefined' };
    if (typ === 'boolean' || typ === 'number') return { t:'primitive', value:value };
    if (typ === 'string') return clipString(value);
    if (typ === 'bigint') return { t:'bigint', value:String(value) };
    if (typ === 'symbol') return { t:'symbol', description: value.description || null };
    if (typ === 'function') {
      var src;
      try { src = Function.prototype.toString.call(value); } catch (e) { src = undefined; }
      if (src && src.length > 500) src = src.slice(0, 500) + '/*…*/';
      return { t:'function', name: value.name || '', source: src };
    }
    // Object-likes
    if (seen.has(value)) return { t:'cycle' };
    seen.add(value);
    try {
      // Error
      if (value instanceof Error) {
        var out = { t:'error', name: value.name || 'Error', message: String(value.message || ''), stack: value.stack ? String(value.stack) : undefined };
        var cause = value.cause;
        if (cause !== undefined) out.cause = serialize(cause, depth+1, seen);
        return out;
      }
      // Date
      if (value instanceof Date) return { t:'date', iso: isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
      // RegExp
      if (value instanceof RegExp) return { t:'regexp', source: value.source, flags: value.flags };
      // Map
      if (value instanceof Map) {
        var entries = [];
        var i = 0;
        for (var pair of value) {
          if (i++ >= MAX_ENTRIES) return { t:'map', entries: entries, truncated:true };
          entries.push([serialize(pair[0], depth+1, seen), serialize(pair[1], depth+1, seen)]);
        }
        return { t:'map', entries: entries };
      }
      // Set
      if (value instanceof Set) {
        var sentries = [];
        var j = 0;
        for (var v of value) {
          if (j++ >= MAX_ENTRIES) return { t:'set', entries: sentries, truncated:true };
          sentries.push(serialize(v, depth+1, seen));
        }
        return { t:'set', entries: sentries };
      }
      // DOM Node
      if (typeof Node !== 'undefined' && value instanceof Node) {
        var el = value;
        var tag = (el.nodeName || '').toLowerCase();
        var html;
        try { html = el.outerHTML ? String(el.outerHTML).slice(0, 500) : undefined; } catch(_){}
        return {
          t:'node',
          tagName: tag,
          id: el.id || undefined,
          classes: el.classList ? Array.prototype.slice.call(el.classList) : undefined,
          outerHTML: html
        };
      }
      // TypedArray
      if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        var ta = value;
        var preview = [];
        var len = Math.min(ta.length, 16);
        for (var k = 0; k < len; k++) preview.push(Number(ta[k]));
        return { t:'typedarray', className: ta.constructor && ta.constructor.name || 'TypedArray', length: ta.length, preview: preview };
      }
      // Promise (best-effort: state not synchronously knowable)
      if (typeof Promise !== 'undefined' && value instanceof Promise) {
        return { t:'promise' };
      }
      // Array
      if (Array.isArray(value)) {
        var arr = [];
        for (var ai = 0; ai < value.length; ai++) {
          if (ai >= MAX_ENTRIES) return { t:'array', entries: arr, truncated:true };
          arr.push(serialize(value[ai], depth+1, seen));
        }
        return { t:'array', entries: arr };
      }
      // Plain object
      var obj = {};
      var keys;
      try { keys = Object.keys(value); } catch (e) { keys = []; }
      var truncated = false;
      for (var ki = 0; ki < keys.length; ki++) {
        if (ki >= MAX_ENTRIES) { truncated = true; break; }
        var key = keys[ki];
        try { obj[key] = serialize(value[key], depth+1, seen); }
        catch (e) { obj[key] = { t:'unknown', description: 'threw on access: ' + (e && e.message) }; }
      }
      var className;
      try { className = (value.constructor && value.constructor.name) || undefined; } catch(_){}
      var res = { t:'object', entries: obj };
      if (className && className !== 'Object') res.className = className;
      if (truncated) res.truncated = true;
      return res;
    } finally {
      seen.delete(value);
    }
  }

  function snapshot(args){
    var seen = new WeakSet();
    var out = [];
    for (var i = 0; i < args.length; i++) {
      try { out.push(serialize(args[i], 0, seen)); }
      catch (e) { out.push({ t:'unknown', description: 'serialize threw: ' + (e && e.message) }); }
    }
    return out;
  }

  var levels = ['log','info','warn','error','debug','trace','table','dir','group','groupCollapsed','assert'];
  var orig = {};
  for (var li = 0; li < levels.length; li++) {
    var lvl = levels[li];
    if (typeof console[lvl] !== 'function') continue;
    orig[lvl] = console[lvl].bind(console);
  }

  function emit(level, args){
    var payload;
    try { payload = JSON.stringify({ level: level, args: snapshot(args) }); }
    catch (e) { payload = JSON.stringify({ level: level, args: [{ t:'unknown', description:'stringify failed' }] }); }
    // Use console.debug so the marker doesn't pollute warn/error counters; the host
    // filters these out of the visible NDJSON before writing.
    if (orig.debug) orig.debug(MARKER, payload);
    else if (orig.log) orig.log(MARKER, payload);
  }

  for (var li2 = 0; li2 < levels.length; li2++) {
    (function(level){
      if (!orig[level]) return;
      console[level] = function(){
        var a = Array.prototype.slice.call(arguments);
        try { emit(level, a); } catch(_){}
        try { return orig[level].apply(console, a); } catch(_){}
      };
    })(levels[li2]);
  }
})();
`;
}
