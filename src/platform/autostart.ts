import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Background programs that start at logon, per platform:
 *   Windows  Task Scheduler tasks "WhatsApp Operator *" (plus one that locks the screen at logon)
 *   macOS    launchd agents in ~/Library/LaunchAgents (caffeinate keeps the Mac awake while running)
 *   Linux    systemd user units in ~/.config/systemd/user
 * stop() turns autostart off as well, so nothing comes back after a reboot until start().
 */

export const TUNNEL_NAME = 'wa-operator';

export interface AutostartOptions {
  /** The app folder (holds dist/ and .env). */
  root: string;
  /** cloudflared path when a named tunnel runs as its own program. */
  tunnelBin?: string;
}

interface Unit {
  /** Name shown to the owner. */
  label: string;
  /** Task name, launchd label or systemd unit. */
  id: string;
  exe: string;
  args: string[];
  restart: boolean;
}

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function units(o: AutostartOptions): Unit[] {
  const service = path.join(o.root, 'dist', 'bin', 'service.js');
  const list: Unit[] = [{ label: 'service', id: ids.service, exe: process.execPath, args: [service], restart: true }];
  if (o.tunnelBin)
    list.push({
      label: 'tunnel',
      id: ids.tunnel,
      exe: o.tunnelBin,
      args: ['tunnel', 'run', TUNNEL_NAME],
      restart: true,
    });
  if (WIN)
    list.push({
      label: 'lock at logon',
      id: ids.lock,
      exe: 'rundll32.exe',
      args: ['user32.dll,LockWorkStation'],
      restart: false,
    });
  return list;
}

const ids = WIN
  ? { service: 'WhatsApp Operator Mode', tunnel: 'WhatsApp Operator Tunnel', lock: 'WhatsApp Operator Lock' }
  : MAC
    ? { service: 'com.wa-operator.service', tunnel: 'com.wa-operator.tunnel', lock: '' }
    : { service: 'wa-operator.service', tunnel: 'wa-operator-tunnel.service', lock: '' };

const ALL_IDS = [ids.service, ids.tunnel, ids.lock].filter(Boolean);

function sh(cmd: string, args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    ...(input !== undefined ? { input } : {}),
  });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const ps = (script: string) =>
  sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], script);
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---- file locations -------------------------------------------------------------------------------

const launchAgents = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = (id: string) => path.join(launchAgents(), `${id}.plist`);
const systemdDir = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const gui = () => `gui/${process.getuid?.() ?? 501}`;

/** Ids of units installed on this machine. */
function installed(): string[] {
  if (WIN) {
    const r = ps(
      `Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object TaskName -like 'WhatsApp Operator *' | ForEach-Object TaskName`,
    );
    return r.out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => ALL_IDS.includes(s));
  }
  if (MAC) return ALL_IDS.filter((id) => fs.existsSync(plistPath(id)));
  return ALL_IDS.filter((id) => fs.existsSync(path.join(systemdDir(), id)));
}

// ---- unit files -------------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(u: Unit, root: string): string {
  // caffeinate -is: no idle or system sleep while the program runs (like "sleep off" on Windows).
  const argv = ['/usr/bin/caffeinate', '-is', u.exe, ...u.args];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(u.id)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><${u.restart}/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(path.join(root, 'logs', `${u.label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(root, 'logs', `${u.label}.out.log`))}</string>
</dict>
</plist>
`;
}

function systemdUnit(u: Unit, root: string): string {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  return `[Unit]
Description=WhatsApp Operator Mode (${u.label})
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${root}
Environment=${q(`PATH=${process.env.PATH ?? '/usr/bin:/bin'}`)}
ExecStart=${[u.exe, ...u.args].map(q).join(' ')}
Restart=${u.restart ? 'always' : 'no'}
RestartSec=60

[Install]
WantedBy=default.target
`;
}

function winTask(u: Unit, root: string): string {
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const args = u.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return `
$a = New-ScheduledTaskAction -Execute ${psq(u.exe)} -Argument ${psq(args)} -WorkingDirectory ${psq(root)}
$t = New-ScheduledTaskTrigger -AtLogOn -User ${psq(user)}
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable ${u.restart ? '-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)' : ''} -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId ${psq(user)} -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${psq(u.id)} -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`;
}

// ---- public API -------------------------------------------------------------------------------------

/** Register (or re-register) the programs, keep the machine awake, and start them. */
export function installAutostart(o: AutostartOptions): string[] {
  const list = units(o);
  const notes: string[] = [];
  // A tunnel from an earlier setup that is no longer wanted.
  if (!o.tunnelBin && installed().includes(ids.tunnel)) remove([ids.tunnel]);

  if (WIN) {
    const r = ps(
      list.map((u) => winTask(u, o.root)).join('\n') +
        `
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0`,
    );
    if (!r.ok) throw new Error(r.out);
    notes.push('sleep is off on mains power');
  } else if (MAC) {
    fs.mkdirSync(launchAgents(), { recursive: true });
    for (const u of list) {
      sh('launchctl', ['bootout', `${gui()}/${u.id}`]);
      fs.writeFileSync(plistPath(u.id), plist(u, o.root));
    }
    notes.push('the Mac stays awake while the service runs');
  } else {
    fs.mkdirSync(systemdDir(), { recursive: true });
    for (const u of list) fs.writeFileSync(path.join(systemdDir(), u.id), systemdUnit(u, o.root));
    const r = sh('systemctl', ['--user', 'daemon-reload']);
    if (!r.ok) throw new Error(`systemd user session not available: ${r.out}`);
    // Linger: start at boot without anyone logging in, and keep running after logout.
    const linger = sh('loginctl', ['enable-linger', os.userInfo().username]);
    notes.push(
      linger.ok
        ? 'starts at boot, even before anyone logs in'
        : `starts when you log in (for start at boot run: sudo loginctl enable-linger ${os.userInfo().username})`,
    );
    notes.push(
      'to stop the PC from sleeping: sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target',
    );
  }
  startAll();
  return notes;
}

/** Turn autostart back on and start everything. */
export function startAll(): string[] {
  const have = installed();
  if (!have.length) throw new Error('nothing installed yet: run npm run setup -- --only autostart');
  if (WIN) {
    const r = ps(
      have.map((id) => `Enable-ScheduledTask -TaskName ${psq(id)} | Out-Null`).join('\n') +
        '\n' +
        have
          .filter((id) => id !== ids.lock)
          .map((id) => `Start-ScheduledTask -TaskName ${psq(id)}`)
          .join('\n'),
    );
    if (!r.ok) throw new Error(r.out);
  } else if (MAC) {
    for (const id of have) {
      sh('launchctl', ['enable', `${gui()}/${id}`]);
      const r = sh('launchctl', ['bootstrap', gui(), plistPath(id)]);
      // Already loaded: just make sure it runs.
      if (!r.ok) sh('launchctl', ['kickstart', `${gui()}/${id}`]);
    }
  } else {
    const r = sh('systemctl', ['--user', 'enable', '--now', ...have]);
    if (!r.ok) throw new Error(r.out);
  }
  return have;
}

/** Stop everything, including leftovers, and turn autostart off. */
export function stopAll(root: string, port = 3100): { units: string[]; killed: number } {
  const have = installed();
  if (WIN) {
    ps(
      have
        .map(
          (id) =>
            `Disable-ScheduledTask -TaskName ${psq(id)} | Out-Null; Stop-ScheduledTask -TaskName ${psq(id)} -ErrorAction SilentlyContinue`,
        )
        .join('\n'),
    );
  } else if (MAC) {
    for (const id of have) {
      sh('launchctl', ['disable', `${gui()}/${id}`]);
      sh('launchctl', ['bootout', `${gui()}/${id}`]);
    }
  } else if (have.length) {
    sh('systemctl', ['--user', 'disable', '--now', ...have]);
  }
  return { units: have, killed: killLeftovers(root, port) };
}

/** Stop and delete everything (uninstall). */
export function removeAutostart(root: string, port = 3100): { units: string[]; killed: number } {
  const res = stopAll(root, port);
  remove(res.units);
  return res;
}

function remove(list: string[]): void {
  if (!list.length) return;
  if (WIN) {
    ps(
      list
        .map(
          (id) =>
            `Stop-ScheduledTask -TaskName ${psq(id)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psq(id)} -Confirm:$false -ErrorAction SilentlyContinue`,
        )
        .join('\n'),
    );
  } else if (MAC) {
    for (const id of list) {
      sh('launchctl', ['bootout', `${gui()}/${id}`]);
      sh('launchctl', ['enable', `${gui()}/${id}`]); // clear the "disabled" mark
      fs.rmSync(plistPath(id), { force: true });
    }
  } else {
    sh('systemctl', ['--user', 'disable', '--now', ...list]);
    for (const id of list) fs.rmSync(path.join(systemdDir(), id), { force: true });
    sh('systemctl', ['--user', 'daemon-reload']);
  }
}

export interface UnitStatus {
  label: string;
  installed: boolean;
  enabled: boolean;
}

/** What is registered and whether it will start at logon. */
export function autostartStatus(withTunnel: boolean): UnitStatus[] {
  const want = [{ label: 'service', id: ids.service }, ...(withTunnel ? [{ label: 'tunnel', id: ids.tunnel }] : [])];
  const have = installed();
  let disabled: string[] = [];
  if (WIN && have.length) {
    disabled = ps(
      `Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'WhatsApp Operator *' -and $_.State -eq 'Disabled' } | ForEach-Object TaskName`,
    )
      .out.split(/\r?\n/)
      .map((s) => s.trim());
  } else if (MAC && have.length) {
    const out = sh('launchctl', ['print-disabled', gui()]).out;
    disabled = have.filter((id) => new RegExp(`"${id.replace(/\./g, '\\.')}" => (true|disabled)`).test(out));
  } else if (have.length) {
    disabled = have.filter((id) => sh('systemctl', ['--user', 'is-enabled', id]).out !== 'enabled');
  }
  return want.map((w) => ({
    label: w.label,
    installed: have.includes(w.id),
    enabled: have.includes(w.id) && !disabled.includes(w.id),
  }));
}

/**
 * The scheduler only ends the program it started. Children (quick tunnel, Claude) and a manual
 * `npm run dev` can remain, so end them by command line: this app's service, and the cloudflared that
 * serves this app (quick tunnel to our port, or the named tunnel).
 */
function killLeftovers(root: string, port: number): number {
  const procs: { pid: number; cmd: string }[] = [];
  if (WIN) {
    const r = ps(
      `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cloudflared.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
    );
    for (const l of r.out.split(/\r?\n/)) {
      const [pid, cmd] = l.split('\t');
      if (pid && cmd) procs.push({ pid: Number(pid), cmd });
    }
  } else {
    for (const l of sh('ps', ['-axo', 'pid=,command=']).out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      if (m) procs.push({ pid: Number(m[1]), cmd: m[2]! });
    }
  }
  const norm = (s: string) => (WIN ? s.toLowerCase().replace(/\//g, '\\') : s);
  const rootN = norm(root);
  const mine = procs.filter(
    ({ pid, cmd }) =>
      pid !== process.pid &&
      ((norm(cmd).includes(rootN) && /service\.(js|ts)/.test(cmd)) ||
        (/cloudflared/i.test(cmd) &&
          (cmd.includes(`127.0.0.1:${port}`) ||
            cmd.includes(`localhost:${port}`) ||
            new RegExp(`tunnel\\s.*run\\s+${TUNNEL_NAME}\\b`).test(cmd)))),
  );
  for (const { pid } of mine) {
    if (WIN) sh('taskkill', ['/PID', String(pid), '/T', '/F']);
    else
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
  }
  return mine.length;
}
