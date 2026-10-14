import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Secrets live in the operating system's secret store under "wa-operator:<NAME>", never in `.env`,
 * so Claude's own file tools have nothing to read:
 *   Windows  Credential Manager (DPAPI, bound to the owner's login)
 *   macOS    login Keychain
 *   Linux    Secret Service keyring (secret-tool); on a server without a keyring, an owner-only file
 * Environment variables still work (dev, CI), and `WAOP_DISABLE_CREDMAN=1` turns the store off.
 */

export const SECRET_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  /** Encrypts the database and the WhatsApp link session (made automatically). */
  'OPERATOR_DATA_KEY',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const TARGET_PREFIX = 'wa-operator:';

const CRED_TYPE = String.raw`
Add-Type -Namespace WaOp -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredDeleteW(string target, int type, int flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
public static string Read(string target) {
  IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null;
  try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
  finally { CredFree(p); }
}
public static bool Write(string target, string secret) {
  var bytes = System.Text.Encoding.Unicode.GetBytes(secret);
  var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.Persist = 2; c.UserName = "wa-operator";
  c.CredentialBlobSize = bytes.Length; c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
  try { Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length); return CredWriteW(ref c, 0); }
  finally { Marshal.FreeHGlobal(c.CredentialBlob); }
}
'@
`;

function powershell(script: string, stdin?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    {
      input: script,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, WAOP_SECRET_IN: stdin ?? '' },
    },
  );
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function run(cmd: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...(input !== undefined ? { input } : {}) });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

type Backend = 'credman' | 'keychain' | 'libsecret' | 'file';
let backend: Backend | null | undefined;

function detect(): Backend | null {
  if (process.env.WAOP_DISABLE_CREDMAN === '1') return null;
  if (process.platform === 'win32') return 'credman';
  if (process.platform === 'darwin') return 'keychain';
  // secret-tool only works with a running keyring (desktop session). "Not found" exits 1 silently;
  // no keyring exits 1 with an error message.
  const probe = spawnSync('secret-tool', ['lookup', 'service', 'wa-operator', 'account', '__probe__'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (!probe.error && (probe.status === 0 || (probe.status === 1 && !probe.stderr.trim()))) return 'libsecret';
  return 'file';
}

function current(): Backend | null {
  if (backend === undefined) backend = detect();
  return backend;
}

export function secretStoreAvailable(): boolean {
  return current() !== null;
}

/** Where secrets are kept on this machine, for messages. */
export function secretStoreName(): string {
  switch (current()) {
    case 'credman':
      return 'Windows Credential Manager';
    case 'keychain':
      return 'the macOS Keychain';
    case 'libsecret':
      return 'the system keyring';
    case 'file':
      return `${secretsFile()} (readable only by you)`;
    default:
      return 'environment variables';
  }
}

/** Linux without a keyring: one JSON file, mode 600, in a mode 700 folder outside the app. */
export function secretsFile(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'wa-operator', 'secrets.json');
}

function readFileStore(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeFileStore(all: Record<string, string>): void {
  const f = secretsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(f), 0o700);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Read every named secret. Missing ones are omitted. */
export function readSecrets(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  switch (current()) {
    case 'credman':
      return readCredman(names);
    case 'file': {
      const all = readFileStore();
      for (const n of names) if (all[n]) out[n] = all[n];
      break;
    }
    case 'keychain':
      for (const n of names) {
        const r = run('security', ['find-generic-password', '-a', 'wa-operator', '-s', TARGET_PREFIX + n, '-w']);
        if (r.ok && r.stdout.trim()) out[n] = r.stdout.replace(/\n$/, '');
      }
      break;
    case 'libsecret':
      for (const n of names) {
        const r = run('secret-tool', ['lookup', 'service', 'wa-operator', 'account', n]);
        if (r.ok && r.stdout) out[n] = r.stdout.replace(/\n$/, '');
      }
      break;
    default:
  }
  return out;
}

/** Every named secret in one PowerShell call (about half a second). */
function readCredman(names: readonly string[]): Record<string, string> {
  const list = names.map((n) => `'${TARGET_PREFIX}${n}'`).join(',');
  const script = `${CRED_TYPE}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = @{}
foreach ($t in @(${list})) { $v = [WaOp.Cred]::Read($t); if ($v -ne $null) { $out[$t.Substring(${TARGET_PREFIX.length})] = $v } }
[Console]::Out.Write(($out | ConvertTo-Json -Compress))`;
  const r = powershell(script);
  if (!r.ok || !r.stdout.trim()) return {};
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, string>;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/** Store a secret. The value goes through stdin or the child's environment, never argv. */
export function writeSecret(name: SecretName, value: string): void {
  let r = { ok: true, stderr: '' };
  switch (current()) {
    case 'credman':
      r = powershell(
        `${CRED_TYPE}
if (-not [WaOp.Cred]::Write('${TARGET_PREFIX}${name}', $env:WAOP_SECRET_IN)) { exit 1 }`,
        value,
      );
      break;
    case 'keychain': {
      // `security -i` reads the command from stdin, so the value never shows in the process list.
      const q = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`;
      const target = q(TARGET_PREFIX + name);
      r = run('security', ['-i'], `add-generic-password -U -a wa-operator -s ${target} -l ${target} -w ${q(value)}\n`);
      break;
    }
    case 'libsecret':
      r = run(
        'secret-tool',
        ['store', '--label', TARGET_PREFIX + name, 'service', 'wa-operator', 'account', name],
        value,
      );
      break;
    case 'file':
      writeFileStore({ ...readFileStore(), [name]: value });
      break;
    default:
      throw new Error('No secret store (WAOP_DISABLE_CREDMAN=1): set it as an environment variable instead.');
  }
  if (!r.ok) throw new Error(`Could not save ${name} to ${secretStoreName()}: ${r.stderr.trim().slice(0, 300)}`);
}

export function deleteSecret(name: SecretName): boolean {
  switch (current()) {
    case 'credman':
      return powershell(`${CRED_TYPE}
if (-not [WaOp.Cred]::CredDeleteW('${TARGET_PREFIX}${name}', 1, 0)) { exit 1 }`).ok;
    case 'keychain':
      return run('security', ['delete-generic-password', '-a', 'wa-operator', '-s', TARGET_PREFIX + name]).ok;
    case 'libsecret':
      return run('secret-tool', ['clear', 'service', 'wa-operator', 'account', name]).ok;
    case 'file': {
      const all = readFileStore();
      if (!(name in all)) return false;
      delete all[name];
      writeFileStore(all);
      return true;
    }
    default:
      return false;
  }
}
