/**
 * Pretty-print a {@link LogRecord} to stdout for live tail mode.
 *
 * Uses ANSI colors via `chalk` and renders deeply-nested values with `JSON.stringify`
 * (keeping output one-line-per-record so it can be piped/grepped).
 */
import chalk from 'chalk';
import type { LogRecord, SerializedValue } from '../types.js';

export function formatRecord(rec: LogRecord): string {
  const time = rec.ts.slice(11, 23);
  const level = LEVEL_COLOR[rec.level] ?? chalk.white;
  const lvl = level(rec.level.padEnd(5));
  const tgt = chalk.gray(`[${rec.targetLabel}]`);
  const badge = rec.channel === 'native'
    ? chalk.magenta(`(${rec.platform ?? '?'}/native)`) + ' '
    : '';
  const args = rec.args.map(renderInline).join(' ');
  return `${chalk.gray(time)} ${lvl} ${tgt} ${badge}${args}`;
}

const LEVEL_COLOR: Record<string, (s: string) => string> = {
  error: chalk.red.bold,
  warn: chalk.yellow,
  info: chalk.cyan,
  log: chalk.white,
  debug: chalk.gray,
  trace: chalk.gray,
  verbose: chalk.gray,
};

function renderInline(v: SerializedValue): string {
  switch (v.t) {
    case 'undefined': return 'undefined';
    case 'primitive': return String(v.value);
    case 'string': return JSON.stringify(v.value) + (v.truncated ? '…' : '');
    case 'bigint': return v.value + 'n';
    case 'symbol': return `Symbol(${v.description ?? ''})`;
    case 'function': return `ƒ ${v.name || ''}()`;
    case 'date': return `Date(${v.iso})`;
    case 'regexp': return `/${v.source}/${v.flags}`;
    case 'cycle': return '[Circular]';
    case 'truncated': return `[…${v.reason}]`;
    case 'unknown': return `[?${v.description ?? ''}]`;
    case 'promise': return `Promise${v.state ? `(${v.state})` : ''}`;
    case 'node': return `<${v.tagName}${v.id ? ` #${v.id}` : ''}>`;
    case 'typedarray': return `${v.className}(${v.length})`;
    case 'error': return `${v.name}: ${v.message}`;
    case 'array': return `[${v.entries.map(renderInline).join(', ')}${v.truncated ? ', …' : ''}]`;
    case 'object': {
      const head = v.className && v.className !== 'Object' ? `${v.className} ` : '';
      const body = Object.entries(v.entries).map(([k, val]) => `${k}: ${renderInline(val)}`).join(', ');
      return `${head}{ ${body}${v.truncated ? ', …' : ''} }`;
    }
    case 'map': return `Map(${v.entries.length})`;
    case 'set': return `Set(${v.entries.length})`;
    default: return JSON.stringify(v);
  }
}
