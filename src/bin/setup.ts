#!/usr/bin/env node
/* eslint-disable no-console -- interactive wizard */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { appRoot } from '../config/env.js';
import { MetaClient } from '../meta/client.js';
import { silentLogger } from '../observability/logger.js';
import { readSecrets, SECRET_NAMES, writeSecret, type SecretName } from '../security/secrets.js';
import { ask, askHidden, confirm } from '../shared/prompt.js';

/**
 * One-shot setup wizard. Run it at the shop PC (normal, non-elevated PowerShell):
 *   npm run setup                    every step
 *   npm run setup -- --only meta     just some steps (comma separated)
 *   npm run setup -- --skip watcher  everything except some steps
 * Every step is safe to re-run. Only BIOS "power on after power loss" is left by hand.
 */

// npm/npx/winget are .cmd shims on Windows and need shell: true; the arguments are ours, not user input.
process.noDeprecation = true;

const ROOT = appRoot();
const ENV_PATH = path.join(ROOT, '.env');
const STEPS = [
  'build',
  'env',
  'claude',
  'meta',
  'flow',
  'templates',
  'pin',
  'tunnel',
  'autostart',
  'webhook',
  'autologon',
  'watcher',
] as const;
type Step = (typeof STEPS)[number];
const GRAPH = 'https://graph.facebook.com/v24.0';
const TUNNEL = 'wa-operator';

// ---- helpers ----------------------------------------------------------------------------------------

const log = {
  step: (s: string) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`),
  ok: (s: string) => console.log(`  \x1b[32m✔\x1b[0m ${s}`),
  warn: (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`),
};

function readEnv(): Record<string, string> {
  return fs.existsSync(ENV_PATH) ? parseDotenv(fs.readFileSync(ENV_PATH)) : {};
}

/** Set keys in .env, keeping comments and other lines. */
function setEnv(values: Record<string, string>): void {
  const src = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8')
    : fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  let out = src;
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^#?\\s*${k}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(ENV_PATH, out);
}

function run(cmd: string, args: string[], opts: { input?: string; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32' && !/\.exe$/i.test(cmd),
    stdio: opts.input !== undefined || opts.quiet ? 'pipe' : 'inherit',
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function ps(script: string) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { input: script });
}

const has = (cmd: string) => run('where', [cmd], { quiet: true }).ok;

const secrets: Record<string, string> = {};
async function secret(name: SecretName, prompt: string, gen?: () => string): Promise<string> {
  if (secrets[name]) return secrets[name];
  const v = gen ? gen() : await askHidden(prompt);
  if (!v) throw new Error(`${name} is required`);
  writeSecret(name, v);
  secrets[name] = v;
  log.ok(`${name} saved to Credential Manager`);
  return v;
}

function meta(): MetaClient {
  const env = readEnv();
  return new MetaClient({
    baseUrl: GRAPH.replace('v24.0', env.WHATSAPP_API_VERSION ?? 'v24.0'),
    accessToken: secrets.WHATSAPP_ACCESS_TOKEN!,
    appSecret: secrets.META_APP_SECRET!,
    appsecretProof: true,
    logger: silentLogger,
  });
}

async function waitFor(url: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ---- steps --------------------------------------------------------------------------------------------

const steps: Record<Step, () => Promise<void>> = {
  async build() {
    log.step('Install and build');
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) run('npm', ['install']);
    if (!run('npm', ['run', 'build']).ok) throw new Error('build failed');
    log.ok('built');
  },

  async env() {
    log.step('Basic settings (.env)');
    const e = readEnv();
    const home = os.homedir();
    setEnv({
      CHANNEL: await ask('Chat app: whatsapp or telegram', e.CHANNEL ?? 'whatsapp'),
      OPERATOR_WA_ID: (
        await ask("Owner's personal WhatsApp number (country code, digits only)", e.OPERATOR_WA_ID)
      ).replace(/\D/g, ''),
      OPERATOR_ROOTS: await ask(
        'Work folders Claude may change (comma separated)',
        e.OPERATOR_ROOTS?.includes('%')
          ? path.join(home, 'Documents', 'Shop')
          : (e.OPERATOR_ROOTS ?? path.join(home, 'Documents', 'Shop')),
      ),
      BUSINESS_NAME: await ask('Business name', e.BUSINESS_NAME === 'Rahim Fashion' ? undefined : e.BUSINESS_NAME),
      BUSINESS_DESCRIPTION: await ask(
        'One-line description (e.g. clothing shop in Mirpur)',
        e.BUSINESS_DESCRIPTION === 'clothing shop in Mirpur, Dhaka' ? undefined : e.BUSINESS_DESCRIPTION,
      ),
      BUSINESS_TIMEZONE: await ask('Time zone', e.BUSINESS_TIMEZONE ?? 'Asia/Dhaka'),
    });
    for (const r of readEnv().OPERATOR_ROOTS!.split(',')) fs.mkdirSync(r.trim(), { recursive: true });
    if (readEnv().CHANNEL === 'telegram') {
      await secret('TELEGRAM_BOT_TOKEN', 'Telegram bot token from @BotFather');
      setEnv({
        TELEGRAM_OPERATOR_USER_ID: await ask(
          "Owner's Telegram numeric user ID (ask @userinfobot)",
          readEnv().TELEGRAM_OPERATOR_USER_ID,
        ),
      });
    }
    log.ok(`saved ${ENV_PATH}`);
  },

  async claude() {
    log.step('Claude subscription token');
    if (secrets.CLAUDE_CODE_OAUTH_TOKEN && !(await confirm('A token is already stored. Replace it?', false))) return;
    console.log('  A browser opens to log in; copy the token it prints.');
    run('claude', ['setup-token']);
    await secret('CLAUDE_CODE_OAUTH_TOKEN', 'Paste the token');
  },

  async meta() {
    if (readEnv().CHANNEL === 'telegram') return;
    log.step('WhatsApp Cloud API');
    console.log('  Needs: App ID, App secret, WhatsApp Business Account ID and a System User token');
    console.log(
      '  (Business Settings → System users → Generate token, with whatsapp_business_messaging + _management).',
    );
    const e = readEnv();
    const appId = await ask('Meta App ID', e.META_APP_ID);
    const waba = await ask(
      'WhatsApp Business Account ID (the one only for this number)',
      e.WHATSAPP_BUSINESS_ACCOUNT_ID,
    );
    if (secrets.META_APP_SECRET && (await confirm('Re-enter the App secret and token?', false))) {
      delete secrets.META_APP_SECRET;
      delete secrets.WHATSAPP_ACCESS_TOKEN;
    }
    await secret('META_APP_SECRET', 'App secret');
    await secret('WHATSAPP_ACCESS_TOKEN', 'System User token');
    // Fail early with a clear message if the pair does not match.
    try {
      await meta().request({ method: 'GET', path: '/me' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/appsecret_proof/i.test(msg)) {
        delete secrets.META_APP_SECRET;
        delete secrets.WHATSAPP_ACCESS_TOKEN;
        throw new Error(
          'The App secret does not belong to the app that issued this token. Re-run and enter both again (App Dashboard → App settings → Basic → App secret).',
          { cause: err },
        );
      }
      throw err;
    }
    await secret('META_VERIFY_TOKEN', '', () => secrets.META_VERIFY_TOKEN ?? crypto.randomBytes(24).toString('hex'));
    setEnv({ META_APP_ID: appId, WHATSAPP_BUSINESS_ACCOUNT_ID: waba });

    const nums = await meta().request<{ data: { id: string; display_phone_number: string; verified_name: string }[] }>({
      method: 'GET',
      path: `/${waba}/phone_numbers`,
      query: { fields: 'id,display_phone_number,verified_name' },
    });
    if (!nums.data.length)
      throw new Error('This WhatsApp Business Account has no phone number yet. Add one in WhatsApp Manager.');
    let pick = nums.data[0]!;
    if (nums.data.length > 1) {
      nums.data.forEach((n, i) => console.log(`  ${i + 1}. ${n.display_phone_number} (${n.verified_name})`));
      pick = nums.data[Number(await ask('Which number', '1')) - 1] ?? pick;
    }
    setEnv({ WHATSAPP_PHONE_NUMBER_ID: pick.id });
    log.ok(`number ${pick.display_phone_number} (${pick.verified_name})`);
    await meta().request({ method: 'POST', path: `/${waba}/subscribed_apps` });
    log.ok('app subscribed to the WhatsApp Business Account');
  },

  async flow() {
    if (readEnv().CHANNEL === 'telegram') return;
    log.step('PIN Flow');
    const e = readEnv();
    if (
      e.OPERATOR_PIN_FLOW_ID &&
      !(await confirm(`Flow ${e.OPERATOR_PIN_FLOW_ID} already set. Create a new one?`, false))
    )
      return;
    const c = meta();
    const { id } = await c.request<{ id: string }>({
      method: 'POST',
      path: `/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/flows`,
      body: { name: `operator_pin_${Date.now()}`, categories: ['OTHER'] },
    });
    const form = new FormData();
    form.set('name', 'flow.json');
    form.set('asset_type', 'FLOW_JSON');
    form.set(
      'file',
      new Blob([fs.readFileSync(path.join(ROOT, 'config', 'flows', 'pin-flow.json'))], { type: 'application/json' }),
      'flow.json',
    );
    const up = await c.upload<{ validation_errors?: unknown[] }>(`/${id}/assets`, form);
    if (up.validation_errors?.length) throw new Error(`Flow JSON rejected: ${JSON.stringify(up.validation_errors)}`);
    try {
      await c.request({ method: 'POST', path: `/${id}/publish` });
      setEnv({ OPERATOR_PIN_FLOW_MODE: 'published' });
    } catch (err) {
      // Unverified businesses cannot publish Flows ("Blocked by Integrity"); a draft Flow can still be sent.
      setEnv({ OPERATOR_PIN_FLOW_ID: id, OPERATOR_PIN_FLOW_MODE: 'draft' });
      log.warn(
        `could not publish (${err instanceof Error ? err.message : String(err)}); using the Flow as a draft. Re-run this step after business verification.`,
      );
      return;
    }
    setEnv({ OPERATOR_PIN_FLOW_ID: id });
    log.ok(`Flow ${id} published`);
  },

  async templates() {
    if (readEnv().CHANNEL === 'telegram') return;
    log.step('Message templates (for when the 24-hour window is closed)');
    const e = readEnv();
    const lang = e.OPERATOR_REPLY_TEMPLATE_LANG ?? 'en';
    const list: [string, string][] = [
      ['operator_result_ready', 'Your task on the shop PC has a result. Reply to this message to see it.'],
      ['operator_pc_offline', 'The shop PC is not responding. Operator Mode is offline until it is back.'],
      ['operator_pc_online', 'The shop PC is back online.'],
    ];
    for (const [name, text] of list) {
      try {
        await meta().request({
          method: 'POST',
          path: `/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`,
          body: { name, language: lang, category: 'UTILITY', components: [{ type: 'BODY', text }] },
        });
        log.ok(`${name} submitted (Meta reviews it, usually within minutes)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const sub = (err as { opts?: { subcode?: number } }).opts?.subcode;
        if (sub === 2388024 || /already exists|duplicate/i.test(msg)) log.ok(`${name} already exists`);
        else log.warn(`${name}: ${msg}`);
      }
    }
    setEnv({ OPERATOR_REPLY_TEMPLATE: 'operator_result_ready' });
  },

  async pin() {
    log.step('Owner PIN');
    run('node', [path.join(ROOT, 'dist', 'bin', 'cli.js'), 'set-pin']);
  },

  async tunnel() {
    if (readEnv().CHANNEL === 'telegram') return;
    log.step('Cloudflare tunnel (public URL for the webhook)');
    console.log('  1. quick  - free trycloudflare.com URL, no domain needed. Changes on every restart;');
    console.log('              the service re-registers the webhook automatically each time.');
    console.log('  2. named  - your own stable hostname (needs a domain on Cloudflare). Best for daily use.');
    const mode =
      (await ask('Choose 1 (quick) or 2 (named)', readEnv().TUNNEL_MODE === 'named' ? '2' : '1')) === '2'
        ? 'named'
        : 'quick';
    if (!has('cloudflared')) {
      console.log('  Installing cloudflared with winget…');
      run('winget', [
        'install',
        '--id',
        'Cloudflare.cloudflared',
        '-e',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ]);
      if (!has('cloudflared'))
        throw new Error(
          'cloudflared not found after install. Open a new terminal and re-run: npm run setup -- --only tunnel',
        );
    }
    const bin = run('where', ['cloudflared'], { quiet: true }).out.split(/\r?\n/)[0]?.trim() ?? '';
    if (mode === 'quick') {
      setEnv({ TUNNEL_MODE: 'quick', CLOUDFLARED_BIN: bin });
      log.ok('quick tunnel: the service starts it and registers the webhook on every start');
      return;
    }
    const cfDir = path.join(os.homedir(), '.cloudflared');
    if (!fs.existsSync(path.join(cfDir, 'cert.pem'))) {
      console.log('  A browser opens: pick the domain to use.');
      run('cloudflared', ['tunnel', 'login']);
    }
    const host = await ask(
      'Public hostname for the webhook (on that domain)',
      readEnv().PUBLIC_HOSTNAME ?? 'ops.example.com',
    );
    const list = run('cloudflared', ['tunnel', 'list', '--output', 'json'], { quiet: true });
    let tunnel = (
      JSON.parse(list.ok ? list.out.slice(list.out.indexOf('[')) || '[]' : '[]') as { id: string; name: string }[]
    ).find((t) => t.name === TUNNEL);
    if (!tunnel) {
      run('cloudflared', ['tunnel', 'create', TUNNEL]);
      const again = run('cloudflared', ['tunnel', 'list', '--output', 'json'], { quiet: true });
      tunnel = (JSON.parse(again.out.slice(again.out.indexOf('['))) as { id: string; name: string }[]).find(
        (t) => t.name === TUNNEL,
      );
    }
    if (!tunnel) throw new Error('could not create the tunnel');
    run('cloudflared', ['tunnel', 'route', 'dns', '--overwrite-dns', TUNNEL, host]);
    const port = readEnv().WEBHOOK_PORT ?? '3100';
    fs.writeFileSync(
      path.join(cfDir, 'config.yml'),
      [
        `tunnel: ${tunnel.id}`,
        `credentials-file: ${path.join(cfDir, `${tunnel.id}.json`)}`,
        'ingress:',
        `  - hostname: ${host}`,
        '    path: ^/(webhooks/whatsapp|health/live)$',
        `    service: http://127.0.0.1:${port}`,
        '  - service: http_status:404',
        '',
      ].join('\n'),
    );
    setEnv({ TUNNEL_MODE: 'named', PUBLIC_HOSTNAME: host, CLOUDFLARED_BIN: bin });
    log.ok(`tunnel ${TUNNEL} → https://${host}`);
  },

  async autostart() {
    log.step('Start at logon, keep awake, lock screen at logon');
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const node = process.execPath;
    const cf =
      readEnv().TUNNEL_MODE === 'named'
        ? run('where', ['cloudflared'], { quiet: true }).out.split(/\r?\n/)[0]?.trim()
        : '';
    const task = (name: string, exe: string, args: string, restart = true) => `
$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '${args.replace(/'/g, "''")}' -WorkingDirectory '${ROOT}'
$t = New-ScheduledTaskTrigger -AtLogOn -User '${user}'
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable ${restart ? '-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)' : ''} -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId '${user}' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${name}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`;
    let script = task('WhatsApp Operator Mode', node, `"${path.join(ROOT, 'dist', 'bin', 'service.js')}"`);
    if (cf) script += task('WhatsApp Operator Tunnel', cf, `tunnel run ${TUNNEL}`);
    script += task('WhatsApp Operator Lock', 'rundll32.exe', 'user32.dll,LockWorkStation', false);
    script += `
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Start-ScheduledTask -TaskName 'WhatsApp Operator Mode'
${cf ? "Start-ScheduledTask -TaskName 'WhatsApp Operator Tunnel'" : ''}`;
    const r = ps(script);
    if (!r.ok) throw new Error(r.out);
    log.ok('scheduled tasks registered and started; sleep off on mains power');
    const port = readEnv().WEBHOOK_PORT ?? '3100';
    if (await waitFor(`http://127.0.0.1:${port}/health/live`, 30)) log.ok('service is up');
    else log.warn(`service did not answer yet; check ${path.join(ROOT, 'logs')}`);
  },

  async webhook() {
    if (readEnv().CHANNEL === 'telegram') return;
    log.step('Webhook (per-account override, other projects on the same app keep theirs)');
    const e = readEnv();
    const port = e.WEBHOOK_PORT ?? '3100';
    if (!(await waitFor(`http://127.0.0.1:${port}/health/ready`, 30)))
      throw new Error('the service is not running; run the autostart step first');
    // The service registers the webhook itself on every start; read back what Meta has.
    let base = e.TUNNEL_MODE === 'named' ? `https://${e.PUBLIC_HOSTNAME}` : '';
    if (e.TUNNEL_MODE === 'quick') {
      console.log('  waiting for the quick tunnel URL…');
      for (let i = 0; i < 60 && !base; i++) {
        const log2 = fs.existsSync(path.join(ROOT, 'logs', 'operator.log'))
          ? fs.readFileSync(path.join(ROOT, 'logs', 'operator.log'), 'utf8')
          : '';
        base = [...log2.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].at(-1)?.[0] ?? '';
        if (!base) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!base) throw new Error('no quick tunnel URL yet; check logs/operator.log');
    }
    if (!(await waitFor(`${base}/health/live`, 90)))
      throw new Error(`${base} is not reachable yet. Re-run: npm run setup -- --only webhook`);
    await meta().request({
      method: 'POST',
      path: `/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`,
      body: {
        override_callback_uri: `${base}${e.WEBHOOK_PATH ?? '/webhooks/whatsapp'}`,
        verify_token: secrets.META_VERIFY_TOKEN,
      },
    });
    log.ok(
      `webhook → ${base}${e.WEBHOOK_PATH ?? '/webhooks/whatsapp'} (only for account ${e.WHATSAPP_BUSINESS_ACCOUNT_ID})`,
    );
  },

  async autologon() {
    log.step('Autologon (so a Windows Update reboot does not stop at the login screen)');
    if (!(await confirm('Set up Autologon now? (stores your Windows password encrypted, via Sysinternals)', true)))
      return;
    const exe = path.join(os.tmpdir(), 'Autologon64.exe');
    const dl = await fetch('https://live.sysinternals.com/Autologon64.exe');
    if (!dl.ok) throw new Error('could not download Autologon');
    fs.writeFileSync(exe, Buffer.from(await dl.arrayBuffer()));
    const pass = await askHidden(`Windows password for ${process.env.USERNAME}`);
    const r = run(exe, ['/accepteula', process.env.USERNAME ?? '', process.env.USERDOMAIN ?? '.', pass], {
      quiet: true,
    });
    fs.rmSync(exe, { force: true });
    if (!r.ok)
      throw new Error(`Autologon failed (it may need admin: re-run this step from an elevated terminal): ${r.out}`);
    log.ok('Autologon on; the screen locks right after logon');
  },

  async watcher() {
    if (readEnv().CHANNEL === 'telegram') return;
    log.step('Cloud watcher (Cloudflare Worker, free)');
    if (readEnv().TUNNEL_MODE !== 'named') {
      log.warn('skipped: the watcher needs a stable URL (named tunnel). The quick URL changes on every restart.');
      return;
    }
    const dir = path.join(ROOT, 'scripts', 'watcher');
    const e = readEnv();
    const wr = (args: string[], input?: string) =>
      spawnSync('npx', ['--yes', 'wrangler@3', ...args], {
        cwd: dir,
        shell: true,
        encoding: 'utf8',
        stdio: input !== undefined ? 'pipe' : 'inherit',
        ...(input !== undefined ? { input } : {}),
      });
    if (wr(['whoami']).status !== 0) wr(['login']);
    let toml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
    if (toml.includes('REPLACE_WITH_KV_NAMESPACE_ID')) {
      const kv = spawnSync('npx', ['--yes', 'wrangler@3', 'kv', 'namespace', 'create', 'WATCH'], {
        cwd: dir,
        shell: true,
        encoding: 'utf8',
      });
      const id = /id\s*=\s*"([0-9a-f]+)"/.exec(`${kv.stdout}${kv.stderr}`)?.[1];
      if (!id) throw new Error(`could not create KV namespace: ${kv.stdout}${kv.stderr}`);
      toml = toml.replace('REPLACE_WITH_KV_NAMESPACE_ID', id);
    }
    toml = toml
      .replace(/HEALTH_URL = ".*"/, `HEALTH_URL = "https://${e.PUBLIC_HOSTNAME}/health/live"`)
      .replace(/PHONE_NUMBER_ID = ".*"/, `PHONE_NUMBER_ID = "${e.WHATSAPP_PHONE_NUMBER_ID}"`)
      .replace(/OWNER_WA_ID = ".*"/, `OWNER_WA_ID = "${e.OPERATOR_WA_ID}"`)
      .replace(/TEMPLATE_LANG = ".*"/, `TEMPLATE_LANG = "${e.OPERATOR_REPLY_TEMPLATE_LANG ?? 'en'}"`);
    fs.writeFileSync(path.join(dir, 'wrangler.toml'), toml);
    wr(['secret', 'put', 'WHATSAPP_ACCESS_TOKEN'], secrets.WHATSAPP_ACCESS_TOKEN);
    if (wr(['deploy']).status !== 0) throw new Error('wrangler deploy failed');
    log.ok('watcher deployed (pings every 5 minutes)');
  },
};

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('The setup wizard is for the Windows shop PC.');
  if (spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0)
    console.log('\x1b[33mRunning as admin. Scheduled tasks will still run without admin rights.\x1b[0m');
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
  };
  const only = arg('--only');
  const skip = arg('--skip');
  const todo = STEPS.filter((s) => (only.length ? only.includes(s) : true) && !skip.includes(s));
  Object.assign(secrets, readSecrets(SECRET_NAMES));

  const failed: string[] = [];
  for (const s of todo) {
    try {
      await steps[s]();
    } catch (e) {
      failed.push(s);
      log.warn(`${s} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (['build', 'env', 'meta'].includes(s)) break; // later steps depend on these
    }
  }
  console.log('\n────────────────────────────');
  if (failed.length) console.log(`Re-run the failed steps: npm run setup -- --only ${failed.join(',')}`);
  else console.log("Done. Message the operator number from the owner's phone; it will ask for the PIN.");
  console.log('By hand (once): BIOS → "Restore on AC power loss" = Power On.');
  console.log('After the first message, review MCP tools: npm run cli -- tiers, then tiers accept.');
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
