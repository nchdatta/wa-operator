import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretsFile } from '../security/secrets.js';

/**
 * Real-path checks. Every path is resolved before any folder decision: `..`, `~`, %VAR% / $env:VAR,
 * symlinks, junctions and 8.3 short names (fs.realpathSync.native returns the final long path).
 * A path that does not exist yet resolves through its longest existing parent.
 */

const WIN = process.platform === 'win32';

export function expandVars(p: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = p.trim().replace(/^["']|["']$/g, '');
  out = out.replace(/^~(?=$|[\\/])/, os.homedir());
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => env[n] ?? m);
  out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, n: string) => env[n] ?? m);
  out = out.replace(/\$\{?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)\}?/g, (m, n: string) => env[n] ?? m);
  // Git-Bash style /c/Users/... → C:\Users\...
  if (WIN) out = out.replace(/^\/([a-zA-Z])(?=\/|$)/, (_m, d: string) => `${d.toUpperCase()}:`);
  return out;
}

export function realPath(p: string, cwd: string): string {
  const abs = path.resolve(cwd, expandVars(p));
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function norm(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, '');
  return WIN ? n.toLowerCase() : n;
}

export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export interface PathPolicy {
  /** Resolved work folders. */
  roots: string[];
  /** Resolved folders and files that are always blocked. */
  denyPaths: string[];
  /** File-name patterns that are always blocked wherever they are. */
  denyNames: RegExp[];
}

export type PathVerdict = 'deny' | 'inside' | 'outside';

export function checkPath(p: string, cwd: string, policy: PathPolicy): { verdict: PathVerdict; real: string } {
  const real = realPath(p, cwd);
  const base = path.basename(real);
  if (policy.denyNames.some((re) => re.test(base) || re.test(real))) return { verdict: 'deny', real };
  if (policy.denyPaths.some((d) => isInside(real, d))) return { verdict: 'deny', real };
  return { verdict: policy.roots.some((r) => isInside(real, r)) ? 'inside' : 'outside', real };
}

/** File names that are secret wherever they live. */
export const DENY_NAMES: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|kdbx|ppk)$/i,
  /^\.credentials\.json$/i,
  /^credentials(\.json)?$/i,
  /^(Login Data|Cookies|Web Data|Local State|key[34]\.db|logins\.json|cookies\.sqlite)$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^claude_desktop_config\.json$/i,
  /^\.claude\.json$/i,
];

/** Folders that are always blocked: secrets, browser profiles, this app's own data and code. */
export function defaultDenyPaths(appDir: string, dataDir: string, extra: string[] = []): string[] {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const list = [
    appDir,
    dataDir,
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.azure'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.claude', '.credentials.json'),
    path.join(local, 'Google', 'Chrome', 'User Data'),
    path.join(local, 'Microsoft', 'Edge', 'User Data'),
    path.join(local, 'BraveSoftware'),
    path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'),
    path.join(roaming, 'Opera Software'),
    path.join(roaming, 'Microsoft', 'Credentials'),
    path.join(local, 'Microsoft', 'Credentials'),
    path.join(roaming, 'Microsoft', 'Protect'),
    path.join(roaming, 'Microsoft', 'Crypto'),
    path.join(roaming, 'Claude'),
    path.join(local, 'wa-operator'),
    // macOS
    path.join(home, 'Library', 'Keychains'),
    path.join(home, 'Library', 'Cookies'),
    path.join(home, 'Library', 'Safari'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    path.join(home, 'Library', 'Application Support', 'BraveSoftware'),
    path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'),
    path.join(home, 'Library', 'Application Support', 'com.operasoftware.Opera'),
    path.join(home, 'Library', 'Application Support', 'Claude'),
    // Linux
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium'),
    path.join(home, '.config', 'microsoft-edge'),
    path.join(home, '.config', 'BraveSoftware'),
    path.join(home, '.config', 'opera'),
    path.join(home, '.mozilla'),
    path.join(home, '.local', 'share', 'keyrings'),
    path.join(home, '.config', 'Claude'),
    path.dirname(secretsFile()),
    ...extra,
  ];
  return [...new Set(list.map((p) => realPath(p, home)))];
}
