/**
 * NDJSON filter module.
 *
 * Loads a filter-groups config file, matches {@link LogRecord} entries against
 * the defined groups, and writes a cleaned copy of an NDJSON session file.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LogRecord, LogLevel, LogSource } from './types.js';

// ---------------------------------------------------------------------------
// Filter condition schema
// ---------------------------------------------------------------------------

/**
 * A single conjunction of constraints.  All fields present in the condition
 * must match (AND logic).  Multiple conditions within a group use OR logic.
 */
export interface FilterCondition {
  /** Exact match on record.source. */
  source?: string;
  /** record.level must be one of these values. */
  level?: string[];
  /** Exact match on record.args[0].t */
  args0_t?: string;
  /**
   * Substring that must appear in record.args[0].value
   * (only evaluated when args[0].t === 'string').
   */
  args0_value_contains?: string;
  /**
   * At least one of these prefixes must match the start of record.args[0].value
   * (only evaluated when args[0].t === 'string').
   */
  args0_value_starts_with?: string[];
}

export interface FilterGroup {
  id: string;
  label: string;
  description: string;
  conditions: FilterCondition[];
}

export interface FilterGroupsFile {
  groups: FilterGroup[];
}

// ---------------------------------------------------------------------------
// Loading & validation
// ---------------------------------------------------------------------------

export async function loadFilterGroups(filePath: string): Promise<FilterGroup[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read filter groups file "${filePath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Filter groups file "${filePath}" is not valid JSON: ${(err as Error).message}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('groups' in parsed) ||
    !Array.isArray((parsed as FilterGroupsFile).groups)
  ) {
    throw new Error(
      `Filter groups file "${filePath}" must be a JSON object with a "groups" array.`,
    );
  }

  const file = parsed as FilterGroupsFile;
  for (const g of file.groups) {
    if (typeof g.id !== 'string' || !g.id) {
      throw new Error(`Each filter group must have a non-empty "id" string.`);
    }
    if (!Array.isArray(g.conditions) || g.conditions.length === 0) {
      throw new Error(`Filter group "${g.id}" must have at least one condition.`);
    }
  }

  return file.groups;
}

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

function getArgs0(record: LogRecord): { t: string; value?: unknown } | undefined {
  if (!record.args || record.args.length === 0) return undefined;
  return record.args[0] as { t: string; value?: unknown };
}

function matchesCondition(record: LogRecord, cond: FilterCondition): boolean {
  // source check
  if (cond.source !== undefined && (record.source as string) !== cond.source) {
    return false;
  }

  // level check
  if (cond.level !== undefined && !cond.level.includes(record.level as string)) {
    return false;
  }

  // args[0] checks
  if (
    cond.args0_t !== undefined ||
    cond.args0_value_contains !== undefined ||
    cond.args0_value_starts_with !== undefined
  ) {
    const a0 = getArgs0(record);

    if (cond.args0_t !== undefined) {
      if (!a0 || a0.t !== cond.args0_t) return false;
    }

    if (cond.args0_value_contains !== undefined || cond.args0_value_starts_with !== undefined) {
      if (!a0 || a0.t !== 'string') return false;
      const value = (a0 as { t: 'string'; value: string }).value;

      if (
        cond.args0_value_contains !== undefined &&
        !value.includes(cond.args0_value_contains)
      ) {
        return false;
      }

      if (cond.args0_value_starts_with !== undefined) {
        const anyMatch = cond.args0_value_starts_with.some((prefix) =>
          value.startsWith(prefix),
        );
        if (!anyMatch) return false;
      }
    }
  }

  return true;
}

export function matchesGroup(record: LogRecord, group: FilterGroup): boolean {
  // OR logic across conditions
  return group.conditions.some((cond) => matchesCondition(record, cond));
}

// ---------------------------------------------------------------------------
// Scan pass: count matches per group without writing
// ---------------------------------------------------------------------------

export async function scanGroupCounts(
  inputPath: string,
  groups: FilterGroup[],
): Promise<{ total: number; counts: Map<string, number> }> {
  const counts = new Map<string, number>(groups.map((g) => [g.id, 0]));
  let total = 0;

  const rl = createInterface({
    input: createReadStream(inputPath, 'utf8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;

    let record: LogRecord;
    try {
      record = JSON.parse(trimmed) as LogRecord;
    } catch {
      // Unparseable line — count it but don't match any group
      continue;
    }

    for (const group of groups) {
      if (matchesGroup(record, group)) {
        counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
      }
    }
  }

  return { total, counts };
}

// ---------------------------------------------------------------------------
// Filter + write pass
// ---------------------------------------------------------------------------

export interface FilterResult {
  inputCount: number;
  outputCount: number;
  outputPath: string;
}

export async function writeFiltered(
  inputPath: string,
  selectedGroups: FilterGroup[],
): Promise<FilterResult> {
  // Derive output path: <dir>/<basename-without-ext>.filtered.ndjson
  const dir = dirname(inputPath);
  const ext = extname(inputPath);
  const base = basename(inputPath, ext);
  const outputPath = join(dir, `${base}.filtered.ndjson`);

  const writeStream = createWriteStream(outputPath, { flags: 'w' });

  let inputCount = 0;
  let outputCount = 0;

  const rl = createInterface({
    input: createReadStream(inputPath, 'utf8'),
    crlfDelay: Infinity,
  });

  const writeAsync = (data: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const ok = writeStream.write(data);
      if (ok) {
        resolve();
      } else {
        const onDrain = (): void => {
          writeStream.off('error', onError);
          resolve();
        };
        const onError = (err: Error): void => {
          writeStream.off('drain', onDrain);
          reject(err);
        };
        writeStream.once('drain', onDrain);
        writeStream.once('error', onError);
      }
    });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    inputCount++;

    let record: LogRecord | undefined;
    try {
      record = JSON.parse(trimmed) as LogRecord;
    } catch {
      // Keep unparseable lines (do not silently drop them)
      await writeAsync(trimmed + '\n');
      outputCount++;
      continue;
    }

    const shouldRemove = selectedGroups.some((g) => matchesGroup(record!, g));
    if (!shouldRemove) {
      await writeAsync(JSON.stringify(record) + '\n');
      outputCount++;
    }
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return { inputCount, outputCount, outputPath };
}

// ---------------------------------------------------------------------------
// Analyze pass: find uncovered patterns for authoring new groups
// ---------------------------------------------------------------------------

/** The bucket key used for grouping uncovered records. */
export interface PatternBucket {
  source: string;
  level: string;
  /** The first `prefixLen` chars of args[0].value, or args[0].t when non-string. */
  messagePrefix: string;
  count: number;
  /** A representative full first-arg value (first occurrence). */
  exampleValue: string;
}

/**
 * Scans the input NDJSON and returns high-frequency patterns for records NOT
 * covered by any existing group.  Buckets by (source, level, messagePrefix).
 *
 * @param prefixLen  How many characters of the message to use as the bucket key (default 60).
 * @param topN       Maximum number of buckets to return, sorted by count descending (default 40).
 */
export async function analyzeUncovered(
  inputPath: string,
  existingGroups: FilterGroup[],
  prefixLen = 60,
  topN = 40,
): Promise<{ total: number; uncoveredCount: number; buckets: PatternBucket[] }> {
  let total = 0;
  let uncoveredCount = 0;
  // key → { count, exampleValue }
  const bucketMap = new Map<string, { count: number; exampleValue: string }>();

  const rl = createInterface({
    input: createReadStream(inputPath, 'utf8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;

    let record: LogRecord;
    try {
      record = JSON.parse(trimmed) as LogRecord;
    } catch {
      continue;
    }

    // Skip records already covered by an existing group
    if (existingGroups.some((g) => matchesGroup(record, g))) continue;
    uncoveredCount++;

    const src = (record.source as string) ?? '';
    const lvl = (record.level as string) ?? '';
    const a0 = getArgs0(record);
    let msgPrefix: string;
    let exampleValue: string;

    if (a0?.t === 'string') {
      const val = (a0 as { t: 'string'; value: string }).value;
      msgPrefix = val.slice(0, prefixLen);
      exampleValue = val.length > 120 ? val.slice(0, 120) + '…' : val;
    } else if (a0) {
      msgPrefix = `[${a0.t}]`;
      exampleValue = msgPrefix;
    } else {
      msgPrefix = '(no args)';
      exampleValue = msgPrefix;
    }

    const key = `${src}\x00${lvl}\x00${msgPrefix}`;
    const existing = bucketMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      bucketMap.set(key, { count: 1, exampleValue });
    }
  }

  // Sort descending by count, take topN
  const sorted = [...bucketMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN);

  const buckets: PatternBucket[] = sorted.map(([key, { count, exampleValue }]) => {
    const [src = '', lvl = '', ...rest] = key.split('\x00');
    return { source: src, level: lvl, messagePrefix: rest.join('\x00'), count, exampleValue };
  });

  return { total, uncoveredCount, buckets };
}

/**
 * Serialises the top uncovered buckets into a starter filter-groups JSON
 * scaffold — one group per (source, level) combination, all start-with
 * prefixes collapsed into a single condition.
 */
export function buildGroupsScaffold(buckets: PatternBucket[]): FilterGroupsFile {
  // Collapse buckets into (source, level) → prefixes[]
  const groupMap = new Map<string, { source: string; level: string; prefixes: string[] }>();

  for (const b of buckets) {
    if (!b.messagePrefix.startsWith('[')) {
      // Only prefix-collapsible string messages
      const key = `${b.source}\x00${b.level}`;
      const existing = groupMap.get(key);
      if (existing) {
        existing.prefixes.push(b.messagePrefix);
      } else {
        groupMap.set(key, { source: b.source, level: b.level, prefixes: [b.messagePrefix] });
      }
    }
  }

  const groups: FilterGroup[] = [...groupMap.entries()].map(([, { source, level, prefixes }]) => ({
    id: `${source}-${level}-noise`.replace(/[^a-z0-9-]/g, '-'),
    label: `${source} / ${level} noise (scaffold — edit before use)`,
    description: 'Auto-generated scaffold from dump-logs analyze. Review and refine before committing.',
    conditions: [
      {
        source,
        level: [level],
        args0_value_starts_with: prefixes,
      },
    ],
  }));

  return { groups };
}

// ---------------------------------------------------------------------------
// Interactive multi-select menu (readline-based, no extra deps)
// ---------------------------------------------------------------------------

export interface MenuResult {
  selected: FilterGroup[];
  cancelled: boolean;
}

/**
 * Prints a numbered menu of groups with match counts, prompts the user for a
 * selection, and returns the chosen groups.  Reads from stdin / writes to
 * stderr so it doesn't interfere with piped output.
 */
export async function promptGroupSelection(
  groups: FilterGroup[],
  counts: Map<string, number>,
  total: number,
): Promise<MenuResult> {
  // Print the menu to stderr
  process.stderr.write('\nAvailable filter groups:\n\n');

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const count = counts.get(g.id) ?? 0;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    process.stderr.write(
      `  [${i + 1}] ${g.label}\n` +
        `      ${g.description}\n` +
        `      Matches: ${count.toLocaleString()} / ${total.toLocaleString()} (${pct}%)\n\n`,
    );
  }

  const totalExcludable = groups.reduce((sum, g) => sum + (counts.get(g.id) ?? 0), 0);
  const totalPct = total > 0 ? ((totalExcludable / total) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `  [all] Select all groups (~${totalExcludable.toLocaleString()} entries, ~${totalPct}%)\n\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise<MenuResult>((resolve) => {
    rl.question(
      'Enter group numbers to exclude (space/comma separated, "all", or Enter to cancel): ',
      (answer) => {
        rl.close();

        const trimmed = answer.trim();
        if (!trimmed) {
          resolve({ selected: [], cancelled: true });
          return;
        }

        if (trimmed.toLowerCase() === 'all') {
          resolve({ selected: groups, cancelled: false });
          return;
        }

        const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
        const selected: FilterGroup[] = [];
        const invalid: string[] = [];

        for (const token of tokens) {
          const n = parseInt(token, 10);
          if (isNaN(n) || n < 1 || n > groups.length) {
            invalid.push(token);
          } else {
            const g = groups[n - 1]!;
            if (!selected.includes(g)) selected.push(g);
          }
        }

        if (invalid.length > 0) {
          process.stderr.write(
            `Warning: ignoring unrecognised selection(s): ${invalid.join(', ')}\n`,
          );
        }

        if (selected.length === 0) {
          resolve({ selected: [], cancelled: true });
          return;
        }

        resolve({ selected, cancelled: false });
      },
    );
  });
}
