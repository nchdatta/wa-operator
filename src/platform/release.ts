import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appRoot } from '../config/env.js';

/**
 * Releases are published in the private repo and handed out by the downloads Worker
 * (scripts/downloads), so clients need no GitHub login.
 * The installer scripts do the real work for install, update and uninstall; this side only checks
 * versions and hands over, because on Windows a running node.exe cannot replace its own folder.
 */

/** The downloads Worker. Set once after "wrangler deploy" (see README "Downloads"). */
export const DOWNLOADS_URL = (process.env.WAOP_DOWNLOADS ?? 'https://wa-operator.wa-operator.workers.dev').replace(/\/$/, '');
const WIN = process.platform === 'win32';

export function installerUrl(): string {
  return `${DOWNLOADS_URL}/${WIN ? 'install.ps1' : 'install.sh'}`;
}

export function currentVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; anything after "-" is ignored. */
function parts(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('-')[0]!
    .split('.')
    .map((n) => Number(n) || 0);
}

export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${DOWNLOADS_URL}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`could not check for updates (HTTP ${res.status})`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error('no release published yet');
  return body.version;
}

/**
 * Run the installer script in its own window/process. mode "update" downloads the newest script;
 * "uninstall" uses the copy shipped inside this release. The script waits for this process to exit.
 */
export function handOver(mode: 'update' | 'uninstall'): void {
  const env = { ...process.env, WAOP_MODE: mode, WAOP_WAIT_PID: String(process.pid) };
  const local = path.join(appRoot(), 'scripts', WIN ? 'install.ps1' : 'install.sh');
  if (WIN) {
    const cmd =
      mode === 'update'
        ? `irm '${installerUrl()}' | iex`
        : `& '${local.replace(/'/g, "''")}'`;
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      env,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  const cmd = mode === 'update' ? `curl -fsSL '${installerUrl()}' | bash` : `bash '${local}'`;
  spawn('bash', ['-c', cmd], { env, detached: true, stdio: 'inherit' }).unref();
}
