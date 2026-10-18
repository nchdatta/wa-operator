import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appRoot } from '../config/env.js';

/**
 * Releases are published on this (public) repo's GitHub Releases page; anyone can download them.
 * The installer scripts do the real work for install, update and uninstall; this side only checks
 * versions and hands over, because on Windows a running node.exe cannot replace its own folder.
 */

export const REPO = process.env.WAOP_REPO ?? 'nchdatta/wa-operator';
const DOWNLOADS_URL = `https://github.com/${REPO}/releases/latest/download`;
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
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'wa-operator' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error('no release published yet');
  if (!res.ok) throw new Error(`could not check for updates (GitHub HTTP ${res.status})`);
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error('the latest release has no version tag');
  return body.tag_name.replace(/^v/, '');
}

/**
 * Run the installer script in its own window/process. mode "update" downloads the newest script;
 * "uninstall" uses the copy shipped inside this release. The script waits for this process to exit.
 */
export function handOver(mode: 'update' | 'uninstall'): void {
  const env = { ...process.env, WAOP_MODE: mode, WAOP_WAIT_PID: String(process.pid) };
  const local = path.join(appRoot(), 'scripts', WIN ? 'install.ps1' : 'install.sh');
  if (WIN) {
    const run = mode === 'update' ? `irm '${installerUrl()}' | iex` : `& '${local.replace(/'/g, "''")}'`;
    // A visible window that stays open, so progress and any error can be read.
    const script = [
      `$Host.UI.RawUI.WindowTitle = 'WA Operator ${mode}'`,
      `try { ${run} } catch { Write-Host "\`n${mode === 'update' ? 'Update' : 'Uninstall'} failed: $($_.Exception.Message)" -ForegroundColor Red }`,
      `Read-Host "\`nPress Enter to close"`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // Node's detached processes get no console on Windows; Start-Process opens a normal window.
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`,
      ],
      { env, windowsHide: true },
    );
    return;
  }
  const cmd = mode === 'update' ? `curl -fsSL '${installerUrl()}' | bash` : `bash '${local}'`;
  spawn('bash', ['-c', cmd], { env, detached: true, stdio: 'inherit' }).unref();
}
