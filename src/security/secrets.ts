import { spawnSync } from 'node:child_process';

/**
 * Secrets live in Windows Credential Manager (DPAPI, bound to the owner's Windows login) under
 * "wa-operator:<NAME>", never in `.env`, so Claude's own file tools have nothing to read.
 * On other platforms (dev, CI) they come from environment variables.
 */

export const SECRET_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'TELEGRAM_BOT_TOKEN',
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

export function secretStoreAvailable(): boolean {
  return process.platform === 'win32' && process.env.WAOP_DISABLE_CREDMAN !== '1';
}

/** Read every named secret in one PowerShell call (about half a second). Missing ones are omitted. */
export function readSecrets(names: readonly string[]): Record<string, string> {
  if (!secretStoreAvailable()) return {};
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

/** Store a secret. The value travels through an environment variable of the child, never argv. */
export function writeSecret(name: SecretName, value: string): void {
  if (!secretStoreAvailable()) throw new Error('Windows Credential Manager is only available on Windows.');
  const script = `${CRED_TYPE}
if (-not [WaOp.Cred]::Write('${TARGET_PREFIX}${name}', $env:WAOP_SECRET_IN)) { exit 1 }`;
  const r = powershell(script, value);
  if (!r.ok) throw new Error(`Could not save ${name} to Credential Manager: ${r.stderr.trim().slice(0, 300)}`);
}

export function deleteSecret(name: SecretName): boolean {
  if (!secretStoreAvailable()) return false;
  const r = powershell(`${CRED_TYPE}
if (-not [WaOp.Cred]::CredDeleteW('${TARGET_PREFIX}${name}', 1, 0)) { exit 1 }`);
  return r.ok;
}
