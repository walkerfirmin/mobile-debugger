/**
 * iOS device & simulator discovery.
 *
 * Physical devices are enumerated via libimobiledevice (`idevice_id -l`);
 * booted simulators via `xcrun simctl list devices booted --json`. Both tools
 * are optional — when one is missing we degrade gracefully and surface an
 * actionable error only if that environment was explicitly requested.
 */
import { execa } from 'execa';

export type IosEnv = 'device' | 'simulator';

export interface IosDevice {
  /** UDID of the device or simulator. */
  udid: string;
  /** Human-readable name. */
  name: string;
  /** Whether this is a physical device or a booted simulator. */
  env: IosEnv;
}

/** Thrown when a required external tool is not installed. */
export class MissingToolError extends Error {
  constructor(public tool: string, hint: string) {
    super(`${tool} not found on PATH. ${hint}`);
    this.name = 'MissingToolError';
  }
}

async function hasTool(bin: string): Promise<boolean> {
  try {
    await execa(bin, ['--version'], { reject: false });
    return true;
  } catch {
    return false;
  }
}

/** List paired physical iOS devices via libimobiledevice. */
export async function listPhysicalDevices(): Promise<IosDevice[]> {
  if (!(await hasTool('idevice_id'))) {
    throw new MissingToolError(
      'idevice_id',
      'Install libimobiledevice (e.g. `brew install libimobiledevice`).',
    );
  }
  const { stdout } = await execa('idevice_id', ['-l'], { reject: false });
  const udids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const devices: IosDevice[] = [];
  for (const udid of udids) {
    let name = udid;
    try {
      const { stdout: nm } = await execa('idevicename', ['-u', udid], { reject: false });
      if (nm.trim()) name = nm.trim();
    } catch {
      /* idevicename optional */
    }
    devices.push({ udid, name, env: 'device' });
  }
  return devices;
}

interface SimctlList {
  devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
}

/** List booted iOS simulators via `xcrun simctl`. */
export async function listSimulators(): Promise<IosDevice[]> {
  if (!(await hasTool('xcrun'))) {
    throw new MissingToolError(
      'xcrun',
      'Install Xcode Command Line Tools (`xcode-select --install`).',
    );
  }
  const { stdout } = await execa('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
    reject: false,
  });
  let parsed: SimctlList;
  try {
    parsed = JSON.parse(stdout) as SimctlList;
  } catch {
    return [];
  }
  const devices: IosDevice[] = [];
  for (const list of Object.values(parsed.devices ?? {})) {
    for (const d of list) {
      if (d.state === 'Booted') devices.push({ udid: d.udid, name: d.name, env: 'simulator' });
    }
  }
  return devices;
}

/**
 * Enumerate iOS targets across the requested environment(s). When `env` is
 * `auto` both simulators and physical devices are queried (missing tooling for
 * one is ignored as long as the other yields results).
 */
export async function listIosDevices(env: 'device' | 'simulator' | 'auto'): Promise<IosDevice[]> {
  if (env === 'simulator') return listSimulators();
  if (env === 'device') return listPhysicalDevices();

  const results: IosDevice[] = [];
  const errors: Error[] = [];
  for (const fn of [listSimulators, listPhysicalDevices]) {
    try {
      results.push(...(await fn()));
    } catch (err) {
      errors.push(err as Error);
    }
  }
  if (results.length === 0 && errors.length > 0) {
    // Surface the most actionable error (missing tooling).
    const missing = errors.find((e) => e instanceof MissingToolError);
    throw missing ?? errors[0];
  }
  return results;
}

/**
 * Resolve a single iOS device given an optional UDID and environment. Throws a
 * descriptive error when zero or multiple candidates match.
 */
export async function resolveIosDevice(
  udid: string | undefined,
  env: 'device' | 'simulator' | 'auto',
): Promise<IosDevice> {
  const devices = await listIosDevices(env);
  if (devices.length === 0) {
    throw new Error(
      'No iOS devices or booted simulators found. Boot a simulator (Xcode ▸ Simulator) ' +
        'or connect and pair a device, then retry.',
    );
  }
  if (udid) {
    const found = devices.find((d) => d.udid === udid);
    if (!found) throw new Error(`No iOS device with udid=${udid}`);
    return found;
  }
  if (devices.length > 1) {
    const list = devices.map((d) => `  ${d.udid}\t${d.env}\t${d.name}`).join('\n');
    throw new Error(`Multiple iOS targets found; pass --device <udid>:\n${list}`);
  }
  return devices[0]!;
}
