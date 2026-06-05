#!/usr/bin/env node
/**
 * `dump-logs` CLI entry point.
 *
 * Subcommands:
 *   targets                    list device WebView targets (Android + iOS)
 *   live    [flags]            attach + stream until SIGINT
 *   dump    [flags] --duration capture for a fixed duration then exit
 *
 * Captures WebView (web) console logs over CDP and, optionally, native device
 * logs (Android `logcat` / iOS `os_log`). On exit (graceful or signal) we flush
 * NDJSON, write the HTML viewer, and tear down any `adb forward` rules or
 * `ios-webkit-debug-proxy` instances we created.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { execa } from 'execa';
import { join } from 'node:path';
import { listDevices } from './adb.js';
import { listIosDevices } from './ios/devices.js';
import { acquireWebTarget, type WebTarget } from './platform.js';
import { attach } from './cdp/connect.js';
import { freshFetch } from './cdp/http.js';
import { NdjsonWriter } from './output/ndjson.js';
import { buildViewer } from './output/viewer.js';
import { formatRecord } from './output/tty.js';
import { LogcatStreamer } from './native/android-logcat.js';
import { IosSyslogStreamer } from './native/ios-syslog.js';
import { startViewerServer } from './viewer-server.js';
import type { NativeStreamer } from './native/streamer.js';
import type { CaptureOptions, LogRecord, Platform } from './types.js';

const program = new Command();
program
  .name('dump-logs')
  .description('Dump deep DevTools console logs and native logs from Android and iOS WebView apps.');

program
  .command('targets')
  .description('List devices and reachable CDP page targets (Android + iOS).')
  .option('-p, --platform <name>', 'android | ios', 'android')
  .option('-d, --device <id>', 'ADB serial (Android) or device/simulator UDID (iOS)')
  .option('--env <which>', 'iOS environment: device | simulator | auto', 'auto')
  .action(async (opts: { platform?: string; device?: string; env?: string }) => {
    const platform = (opts.platform === 'ios' ? 'ios' : 'android') as Platform;
    const env = (opts.env as 'device' | 'simulator' | 'auto') ?? 'auto';

    if (platform === 'ios') {
      const devices = await listIosDevices(env);
      console.log(chalk.bold('iOS targets:'));
      if (devices.length === 0) {
        console.log('  (none — boot a simulator or connect a paired device)');
        return;
      }
      for (const d of devices) console.log(`  ${d.udid}\t${d.env}\t${d.name}`);
    } else {
      const devices = await listDevices();
      if (devices.length === 0) {
        console.error('No ADB devices. Plug in your phone, enable USB debugging, run `adb devices`.');
        process.exit(2);
      }
      console.log(chalk.bold('Devices:'));
      for (const d of devices) console.log(`  ${d.serial}\t${d.state}`);
    }

    // Show the live page targets via a temporary forward/proxy.
    let web: WebTarget | undefined;
    try {
      web = await acquireWebTarget({ platform, device: opts.device, env, onInfo: () => {} });
      const r = await freshFetch(`http://127.0.0.1:${web.port}${web.jsonPath}`);
      const list = (await r.json()) as Array<{ id?: string; type?: string; url?: string; title?: string; webSocketDebuggerUrl?: string }>;
      console.log(chalk.bold('\nPage targets:'));
      if (list.length === 0) {
        console.log('  (none — make sure the app is debuggable and a WebView is alive)');
      }
      for (const t of list) {
        // iOS (iwdp) omits `id`; derive it from the WebSocket debugger URL.
        const id = t.id ?? t.webSocketDebuggerUrl?.split('/').pop() ?? '';
        console.log(`  ${id}\t${t.type ?? ''}\t${t.title ?? ''}\t${t.url ?? ''}`);
      }
    } catch (err) {
      console.error(chalk.yellow(`could not list page targets: ${(err as Error).message}`));
    } finally {
      if (web) await web.remove();
    }
  });

interface CaptureFlags {
  platform?: string;
  device?: string;
  env?: string;
  pid?: string;
  port?: string;
  target: string;
  out: string;
  depth: string;
  maxString: string;
  maxEntries: string;
  inject: boolean;
  network: boolean;
  redact?: string;
  tty: boolean;
  duration?: string;
  web: boolean;
  native: boolean;
  bundleId?: string;
  process?: string;
}

async function openBrowser(url: string): Promise<void> {
  try {
    switch (process.platform) {
      case 'darwin':
        await execa('open', [url]);
        return;
      case 'win32':
        await execa('cmd', ['/c', 'start', '', url], { windowsHide: true });
        return;
      default:
        await execa('xdg-open', [url]);
        return;
    }
  } catch {
    // Opening a browser is best-effort; users can copy the printed URL.
  }
}

function commonOptions(cmd: Command): Command {
  return cmd
    .option('-p, --platform <name>', 'android | ios', 'android')
    .option('-d, --device <id>', 'ADB serial (Android) or device/simulator UDID (iOS)')
    .option('--env <which>', 'iOS environment: device | simulator | auto', 'auto')
    .option('--pid <pid>', 'Android: PID of the WebView process to attach to (defaults to first found)')
    .option('--port <port>', 'Use an already-forwarded/proxied local TCP port')
    .option('-t, --target <which>', 'main | all | <targetId>', 'all')
    .option('-o, --out <dir>', 'Output directory', './logs')
    .option('--no-web', 'Disable WebView (web) console capture')
    .option('--native', 'Also capture native device logs (logcat / os_log)', false)
    .option('--bundle-id <id>', 'Native filter: app bundle id (iOS) / package (Android)')
    .option('--process <name>', 'Native filter: process name')
    .option('--depth <n>', 'Max object expansion depth', '10')
    .option('--max-string <n>', 'Max string length before truncation', '10000')
    .option('--max-entries <n>', 'Max entries per array/object/map/set', '200')
    .option('--no-inject', 'Disable the page-side console shim (use CDP fallback only)')
    .option('--network', 'Also enable Network domain (off by default)', false)
    .option('--redact <regex>', 'Regex; matches in serialised strings are masked with ***')
    .option('--no-tty', 'Disable pretty-printed live tail to stdout');
}

function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m)?$/.exec(s.trim());
  if (!m || !m[1]) throw new Error(`Invalid duration: ${s}`);
  const n = Number(m[1]);
  switch (m[2] ?? 's') {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    default: return n * 1000;
  }
}

async function runCapture(flags: CaptureFlags, durationMs: number | undefined): Promise<void> {
  const capture: CaptureOptions = {
    maxDepth: Number(flags.depth),
    maxStringLen: Number(flags.maxString),
    maxEntries: Number(flags.maxEntries),
    inject: flags.inject !== false,
    enableNetwork: !!flags.network,
    redact: flags.redact ? new RegExp(flags.redact, 'g') : undefined,
  };
  for (const [k, v] of Object.entries(capture)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
      throw new Error(`Invalid ${k}: ${v}`);
    }
  }

  const platform: Platform = flags.platform === 'ios' ? 'ios' : 'android';
  const env = (flags.env as 'device' | 'simulator' | 'auto') ?? 'auto';
  const wantWeb = flags.web !== false;
  const wantNative = !!flags.native;
  if (!wantWeb && !wantNative) {
    throw new Error('Nothing to capture: --no-web was set without --native.');
  }

  // Output writer.
  mkdirSync(flags.out, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const basename = `session-${ts}`;
  const writer = new NdjsonWriter({ outDir: flags.out, basename, flushIntervalMs: 1000 });

  const sink = {
    count: 0,
    write(rec: LogRecord) {
      this.count++;
      writer.write(rec);
      if (flags.tty !== false) {
        try { process.stdout.write(formatRecord(rec) + '\n'); } catch { /* stdout closed */ }
      }
    },
  };

  const onInfo = (m: string): void => console.error(chalk.gray(m));

  // Web (WebView console) pipeline.
  let web: WebTarget | undefined;
  let webHandle: { stop(): Promise<void> } | undefined;
  if (wantWeb) {
    try {
      web = await acquireWebTarget({
        platform,
        device: flags.device,
        pid: flags.pid ? Number(flags.pid) : undefined,
        env,
        port: flags.port ? Number(flags.port) : undefined,
        onInfo,
      });
      webHandle = await attach({
        port: web.port,
        jsonPath: web.jsonPath,
        platform,
        target: flags.target as 'main' | 'all' | string,
        capture,
        sink,
        onInfo,
      });
    } catch (err) {
      if (!wantNative) throw err;
      console.error(
        chalk.yellow(
          `web capture unavailable, continuing with native logs only: ${(err as Error).message}`,
        ),
      );
      webHandle = undefined;
      web = undefined;
    }
  }

  // Native (device log) pipeline.
  let native: NativeStreamer | undefined;
  if (wantNative) {
    if (platform === 'ios') {
      const { resolveIosDevice } = await import('./ios/devices.js');
      const device = await resolveIosDevice(flags.device, env);
      native = new IosSyslogStreamer({
        sink,
        udid: device.udid,
        env: device.env,
        processName: flags.process,
        bundleId: flags.bundleId,
        onInfo,
      });
    } else {
      native = new LogcatStreamer({
        sink,
        device: flags.device,
        pid: flags.pid ? Number(flags.pid) : undefined,
        onInfo,
      });
    }
    await native.start();
  }

  let exitCode = 0;
  const cleanup = async (): Promise<void> => {
    if (webHandle) await webHandle.stop();
    if (native) await native.stop();
    await writer.close();
    if (web) await web.remove();
    if (sink.count === 0) {
      console.error(chalk.yellow('no records captured (app may not have logged anything during the capture window)'));
      // Remove the empty NDJSON files so we don't leave 0-byte droppings around.
      for (const f of writer.files()) {
        try { await import('node:fs/promises').then((m) => m.unlink(f)); } catch { /* ignore */ }
      }
    } else {
      // Build viewer.
      const viewerPath = join(flags.out, `${basename}.html`);
      try {
        buildViewer({ ndjsonFiles: writer.files(), outFile: viewerPath });
        console.error(chalk.green(`viewer: ${viewerPath}  (${sink.count} record${sink.count === 1 ? '' : 's'})`));
      } catch (err) {
        console.error(chalk.yellow(`viewer build failed: ${(err as Error).message}`));
      }
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => { console.error(chalk.gray('\nstopping…')); void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });

  if (durationMs !== undefined) {
    setTimeout(() => { void cleanup(); }, durationMs);
  }

  // Keep alive forever otherwise; the attach handle holds open WS connections.
}

commonOptions(program.command('live'))
  .description('Attach and stream logs until interrupted (Ctrl-C).')
  .action(async (flags: CaptureFlags) => {
    try { await runCapture(flags, undefined); } catch (err) {
      console.error(chalk.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

commonOptions(program.command('dump'))
  .description('Capture for a fixed duration then exit.')
  .option('--duration <d>', 'Capture duration (e.g. 30s, 2m, 5000ms)', '30s')
  .action(async (flags: CaptureFlags) => {
    try {
      const ms = parseDuration(flags.duration ?? '30s');
      await runCapture(flags, ms);
    } catch (err) {
      console.error(chalk.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('view <file>')
  .description('Open an .ndjson log file in the browser viewer.')
  .action(async (file: string) => {
    try {
      accessSync(file, constants.R_OK);
      const viewer = await startViewerServer(file);
      console.error(chalk.green(`viewer: ${viewer.url}`));
      await openBrowser(viewer.url);

      const waitForSignal = async (): Promise<NodeJS.Signals> => {
        return await new Promise<NodeJS.Signals>((resolveSignal) => {
          const onSigint = (): void => {
            process.off('SIGTERM', onSigterm);
            resolveSignal('SIGINT');
          };
          const onSigterm = (): void => {
            process.off('SIGINT', onSigint);
            resolveSignal('SIGTERM');
          };
          process.once('SIGINT', onSigint);
          process.once('SIGTERM', onSigterm);
        });
      };

      const signal = await waitForSignal();
      if (signal === 'SIGINT') {
        console.error(chalk.gray('\nstopping viewer…'));
      }
      await viewer.close();
    } catch (err) {
      console.error(chalk.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description(
    'Scan an .ndjson log and report high-frequency patterns NOT covered by your existing\n' +
      'filter groups — so you can identify new noise and extend filter-groups.json.\n' +
      'Use --emit-scaffold to print a starter groups JSON to stdout.',
  )
  .requiredOption('-i, --input <file>', 'Path to the .ndjson file to analyze')
  .option(
    '-g, --groups-file <file>',
    'Existing filter-groups JSON to exclude already-covered records (optional)',
  )
  .option('--top <n>', 'Number of top patterns to show', '40')
  .option('--prefix-len <n>', 'Message prefix length for bucketing', '60')
  .option(
    '--emit-scaffold',
    'Print a starter filter-groups.json scaffold to stdout (pipe to a new file)',
    false,
  )
  .action(
    async (opts: {
      input: string;
      groupsFile?: string;
      top: string;
      prefixLen: string;
      emitScaffold: boolean;
    }) => {
      try {
        const { resolve, dirname: pathDirname, join: pathJoin } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const { loadFilterGroups, analyzeUncovered, buildGroupsScaffold } =
          await import('./filter.js');

        const inputPath = resolve(opts.input);
        if (!existsSync(inputPath)) {
          console.error(chalk.red(`error: input file not found: ${inputPath}`));
          process.exit(1);
        }

        // Load existing groups (optional)
        let existingGroups: Awaited<ReturnType<typeof loadFilterGroups>> = [];
        if (opts.groupsFile) {
          const gfPath = resolve(opts.groupsFile);
          if (!existsSync(gfPath)) {
            console.error(chalk.red(`error: groups file not found: ${gfPath}`));
            process.exit(1);
          }
          existingGroups = await loadFilterGroups(gfPath);
          console.error(chalk.gray(`existing groups: ${gfPath} (${existingGroups.length} group(s))`));
        } else {
          // Auto-detect, same search order as filter command
          const nextToInput = pathJoin(pathDirname(inputPath), 'filter-groups.json');
          const inCwd = pathJoin(process.cwd(), 'filter-groups.json');
          const detected = existsSync(nextToInput)
            ? nextToInput
            : existsSync(inCwd)
              ? inCwd
              : null;
          if (detected) {
            existingGroups = await loadFilterGroups(detected);
            console.error(chalk.gray(`existing groups: ${detected} (${existingGroups.length} group(s) — auto-detected)`));
          } else {
            console.error(chalk.gray('no existing groups file found — analyzing all records'));
          }
        }

        const topN = Math.max(1, parseInt(opts.top, 10) || 40);
        const prefixLen = Math.max(10, parseInt(opts.prefixLen, 10) || 60);

        console.error(chalk.gray(`input       : ${inputPath}`));
        console.error(chalk.gray('Scanning…'));

        const { total, uncoveredCount, buckets } = await analyzeUncovered(
          inputPath,
          existingGroups,
          prefixLen,
          topN,
        );

        const coveredCount = total - uncoveredCount;
        const coveredPct = total > 0 ? ((coveredCount / total) * 100).toFixed(1) : '0.0';
        const uncoveredPct = total > 0 ? ((uncoveredCount / total) * 100).toFixed(1) : '0.0';

        process.stderr.write(
          `\nTotal records   : ${total.toLocaleString()}\n` +
            `Already covered : ${coveredCount.toLocaleString()} (${coveredPct}%)\n` +
            `Uncovered       : ${uncoveredCount.toLocaleString()} (${uncoveredPct}%)\n` +
            `\nTop ${topN} uncovered patterns:\n\n`,
        );

        if (buckets.length === 0) {
          process.stderr.write('  (none — all records are already covered by existing groups)\n');
        } else {
          // Column widths
          const maxSrc = Math.max(6, ...buckets.map((b) => b.source.length));
          const maxLvl = Math.max(5, ...buckets.map((b) => b.level.length));
          const countWidth = buckets[0] ? String(buckets[0].count).length + 1 : 6;

          // Header
          process.stderr.write(
            `  ${'COUNT'.padStart(countWidth)}  ${'PCT'.padStart(5)}` +
              `  ${'SOURCE'.padEnd(maxSrc)}  ${'LEVEL'.padEnd(maxLvl)}  MESSAGE PREFIX\n`,
          );
          process.stderr.write(
            `  ${'-'.repeat(countWidth)}  ${'-----'}` +
              `  ${'-'.repeat(maxSrc)}  ${'-'.repeat(maxLvl)}  ${'-'.repeat(40)}\n`,
          );

          for (const b of buckets) {
            const pct = total > 0 ? ((b.count / total) * 100).toFixed(1) : '0.0';
            process.stderr.write(
              `  ${String(b.count).padStart(countWidth)}  ${pct.padStart(5)}%` +
                `  ${b.source.padEnd(maxSrc)}  ${b.level.padEnd(maxLvl)}  ${b.messagePrefix}\n`,
            );
          }

          if (buckets.length === topN) {
            process.stderr.write(`\n  (showing top ${topN} — use --top <n> to see more)\n`);
          }
        }

        if (opts.emitScaffold) {
          const scaffold = buildGroupsScaffold(buckets);
          process.stdout.write(JSON.stringify(scaffold, null, 2) + '\n');
          process.stderr.write(
            chalk.green('\nScaffold written to stdout. Pipe to a file and edit before use:\n') +
              chalk.gray(`  dump-logs analyze --input ${opts.input} --emit-scaffold > my-groups.json\n`),
          );
        } else if (buckets.length > 0) {
          process.stderr.write(
            chalk.gray(
              '\nTip: add --emit-scaffold to generate a starter filter-groups.json you can edit.\n',
            ),
          );
        }
      } catch (err) {
        console.error(chalk.red(`error: ${(err as Error).message}`));
        process.exit(1);
      }
    },
  );

program
  .command('filter')
  .description(
    'Interactively filter noise groups from an .ndjson log file and write a cleaned copy.\n' +
      'Prints a numbered menu with match counts, prompts for group selection, then writes\n' +
      '<basename>.filtered.ndjson in the same directory as the input file.',
  )
  .requiredOption('-i, --input <file>', 'Path to the .ndjson file to clean')
  .option(
    '-g, --groups-file <file>',
    'Filter-groups JSON config (default: filter-groups.json next to the input file, then ./filter-groups.json)',
  )
  .action(async (opts: { input: string; groupsFile?: string }) => {
    try {
      const { resolve, dirname: pathDirname, join: pathJoin } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const { loadFilterGroups, scanGroupCounts, promptGroupSelection, writeFiltered } =
        await import('./filter.js');

      const inputPath = resolve(opts.input);
      if (!existsSync(inputPath)) {
        console.error(chalk.red(`error: input file not found: ${inputPath}`));
        process.exit(1);
      }

      // Resolve groups file
      let groupsFilePath: string;
      if (opts.groupsFile) {
        groupsFilePath = resolve(opts.groupsFile);
        if (!existsSync(groupsFilePath)) {
          console.error(chalk.red(`error: groups file not found: ${groupsFilePath}`));
          process.exit(1);
        }
      } else {
        const nextToInput = pathJoin(pathDirname(inputPath), 'filter-groups.json');
        const inCwd = pathJoin(process.cwd(), 'filter-groups.json');
        if (existsSync(nextToInput)) {
          groupsFilePath = nextToInput;
        } else if (existsSync(inCwd)) {
          groupsFilePath = inCwd;
        } else {
          console.error(
            chalk.red(
              `error: no filter-groups.json found next to the input file or in the current directory.\n` +
                `  Pass --groups-file <path> to specify the config explicitly.`,
            ),
          );
          process.exit(1);
        }
      }

      console.error(chalk.gray(`groups file : ${groupsFilePath}`));
      console.error(chalk.gray(`input       : ${inputPath}`));
      console.error(chalk.gray('Scanning…'));

      const groups = await loadFilterGroups(groupsFilePath);
      const { total, counts } = await scanGroupCounts(inputPath, groups);

      console.error(chalk.gray(`Total records: ${total.toLocaleString()}`));

      const { selected, cancelled } = await promptGroupSelection(groups, counts, total);

      if (cancelled || selected.length === 0) {
        console.error(chalk.yellow('No groups selected — nothing to do.'));
        process.exit(0);
      }

      console.error(chalk.gray(`\nFiltering ${selected.length} group(s)…`));
      const result = await writeFiltered(inputPath, selected);

      const removed = result.inputCount - result.outputCount;
      const removedPct =
        result.inputCount > 0 ? ((removed / result.inputCount) * 100).toFixed(1) : '0.0';

      console.error(
        chalk.green(
          `\nDone.\n` +
            `  Input  : ${result.inputCount.toLocaleString()} records\n` +
            `  Removed: ${removed.toLocaleString()} (${removedPct}%)\n` +
            `  Output : ${result.outputCount.toLocaleString()} records\n` +
            `  File   : ${result.outputPath}`,
        ),
      );
    } catch (err) {
      console.error(chalk.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(chalk.red(err.stack ?? err.message));
  process.exit(1);
});
