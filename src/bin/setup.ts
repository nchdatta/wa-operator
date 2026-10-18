#!/usr/bin/env node
/* eslint-disable no-console -- interactive wizard */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { appRoot, CHANNEL_ALIASES, envFilePath, isInstalled, stateDir } from '../config/env.js';
import { MetaClient } from '../meta/client.js';
import { silentLogger } from '../observability/logger.js';
import { findClaude } from '../platform/claude-bin.js';
import { installAutostart, TUNNEL_NAME } from '../platform/autostart.js';
import { installVoice } from '../platform/whisper-install.js';
import { readSecrets, SECRET_NAMES, secretStoreName, writeSecret, type SecretName } from '../security/secrets.js';
import { normalizeWaId, setEnvText } from '../shared/dotenv-edit.js';
import { ask, askHidden, confirm } from '../shared/prompt.js';

/**
 * Setup wizard for Windows, macOS and Linux. Run it at the business PC as the normal user
 * (not admin or root). "wa-operator setup" in an installed copy, "npm run setup --" in a git checkout:
 *   setup                    every step, the same for an installed copy and a git checkout
 *   setup --quick            only the basics: business details, Claude login, link WhatsApp, PIN, start
 *   setup --only meta        just some steps (comma separated)
 *   setup --skip watcher     everything except some steps
 * Every step is safe to re-run. Only BIOS "power on after power loss" is left by hand.
 */

// npm/npx/winget are .cmd shims on Windows and need shell: true; the arguments are ours, not user input.
process.noDeprecation = true;

const ROOT = appRoot();
const ENV_PATH = envFilePath();
const STATE = stateDir();
const INSTALLED = isInstalled();
const SETUP = INSTALLED ? 'wa-operator setup' : 'npm run setup --';
const RESTART = INSTALLED ? 'wa-operator restart' : 'npm run restart';
const CLI = INSTALLED ? 'wa-operator' : 'npm run cli --';
const LOG_FILE = path.join(STATE, 'logs', 'operator.log');
const STEPS = [
  'build',
  'env',
  'claude',
  'meta',
  'baileys',
  'flow',
  'templates',
  'pin',
  'voice',
  'browser',
  'tunnel',
  'autostart',
  'webhook',
  'autologon',
  'watcher',
] as const;
type Step = (typeof STEPS)[number];
/** The quick setup: the linked-device channel, so no Meta account, tunnel or domain is needed. */
const QUICK: Step[] = ['env', 'claude', 'baileys', 'pin', 'autostart'];
const GRAPH = 'https://graph.facebook.com/v24.0';
const TUNNEL = TUNNEL_NAME;
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

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
/** CHANNEL as the app reads it (linked → baileys, cloud → whatsapp). */
function channel(): string {
  const v = (readEnv().CHANNEL ?? 'cloud').trim().toLowerCase();
  return CHANNEL_ALIASES[v] ?? v;
}

function setEnv(values: Record<string, string>): void {
  const src = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8')
    : fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  fs.writeFileSync(ENV_PATH, setEnvText(src, values));
}

/** Ask until the number has a country code (01… is taken as Bangladesh). */
async function askWaId(prompt: string, current?: string): Promise<string> {
  for (;;) {
    const n = normalizeWaId(await ask(prompt, current === '8801700000000' ? undefined : current));
    if (n) return n;
    log.warn('Type the number with the country code, e.g. 8801712345678 (Bangladesh) or 447700900123 (UK).');
  }
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

/** Full path of a program on PATH, or ''. */
function which(cmd: string): string {
  const r = run(WIN ? 'where' : 'which', [cmd], { quiet: true });
  return r.ok ? (r.out.split(/\r?\n/)[0]?.trim() ?? '') : '';
}
const has = (cmd: string) => which(cmd) !== '';

const secrets: Record<string, string> = {};
async function secret(name: SecretName, prompt: string, gen?: () => string): Promise<string> {
  if (secrets[name]) return secrets[name];
  const v = gen ? gen() : await askHidden(prompt);
  if (!v) throw new Error(`${name} is required`);
  writeSecret(name, v);
  secrets[name] = v;
  log.ok(`${name} saved to ${secretStoreName()}`);
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

/** True in the quick setup: fewer questions, sensible defaults. */
let quick = false;

const steps: Record<Step, () => Promise<void>> = {
  async build() {
    if (INSTALLED) return; // the download is already built
    log.step('Install and build');
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) run('npm', ['install']);
    if (!run('npm', ['run', 'build']).ok) throw new Error('build failed');
    log.ok('built');
  },

  async env() {
    log.step('About the business');
    const e = readEnv();
    const home = os.homedir();
    const docs = path.join(home, 'Documents');
    if (quick) {
      setEnv({
        CHANNEL: e.CHANNEL ?? 'linked',
        OPERATOR_WA_ID: await askWaId(
          'Your personal WhatsApp number, with country code (e.g. 8801712345678)',
          e.OPERATOR_WA_ID,
        ),
        OPERATOR_ROOTS: e.OPERATOR_ROOTS && !e.OPERATOR_ROOTS.includes('%') ? e.OPERATOR_ROOTS : docs,
        BUSINESS_NAME: await ask('Business name', e.BUSINESS_NAME === 'Rahim Fashion' ? undefined : e.BUSINESS_NAME),
        BUSINESS_DESCRIPTION: await ask(
          'What the business does, in a few words (e.g. clothing shop in Mirpur)',
          e.BUSINESS_DESCRIPTION === 'clothing shop in Mirpur, Dhaka' ? undefined : e.BUSINESS_DESCRIPTION,
        ),
        BUSINESS_TIMEZONE: await ask(
          'Time zone',
          e.BUSINESS_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Dhaka',
        ),
      });
      for (const r of readEnv().OPERATOR_ROOTS!.split(',')) fs.mkdirSync(r.trim(), { recursive: true });
      log.ok(`saved ${ENV_PATH}`);
      return;
    }
    setEnv({
      CHANNEL: await ask(
        'How the owner talks to the PC: linked (spare WhatsApp number as a linked device, easiest), cloud (WhatsApp Business Cloud API from Meta) or telegram',
        ({ baileys: 'linked', whatsapp: 'cloud' } as Record<string, string>)[e.CHANNEL ?? ''] ?? e.CHANNEL ?? 'linked',
      ),
      OPERATOR_WA_ID: await askWaId("Owner's personal WhatsApp number (country code, digits only)", e.OPERATOR_WA_ID),
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
    if (channel() === 'telegram') {
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
    // The normal Claude Code login, not `claude setup-token`: that token is inference-only and cannot use
    // claude.ai connectors (Gmail, Calendar, Drive).
    log.step('Claude subscription login');
    const creds = path.join(os.homedir(), '.claude', '.credentials.json');
    const bin = findClaude() ?? '';
    const loggedIn = () =>
      fs.existsSync(creds) ||
      (bin !== '' && run(bin, ['auth', 'status'], { quiet: true }).out.includes('"loggedIn": true'));
    if (!loggedIn() && bin) {
      console.log('  A browser opens: sign in with the Claude account (Pro or Max) this PC should use.');
      run(bin, ['auth', 'login']);
    }
    if (!loggedIn()) {
      console.log('  Not logged in yet. Finish the sign-in in the browser, or run:  claude auth login');
      while (!loggedIn() && (await confirm('Logged in now?', true)) === true && !loggedIn())
        log.warn('still not logged in');
      if (!loggedIn()) throw new Error(`Claude login missing; re-run: ${SETUP} --only claude`);
    }
    log.ok('using your Claude Code login (connectors like Gmail included)');
  },

  async meta() {
    if (channel() !== 'whatsapp') return;
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

  async baileys() {
    if (channel() !== 'baileys') return;
    log.step('Link the Operator WhatsApp number (Baileys)');
    log.warn('Unofficial WhatsApp Web link: use a spare number, never the business number. It can be banned.');
    console.log(
      '  On the spare phone: WhatsApp → Settings → Linked devices → Link a device, then scan the code below.',
    );
    if (!run(process.execPath, [path.join(ROOT, 'dist', 'bin', 'cli.js'), 'baileys', 'link']).ok)
      throw new Error(`not linked; re-run: ${SETUP} --only baileys`);
    log.ok('linked');
  },

  async flow() {
    if (channel() !== 'whatsapp') return;
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
      // Unverified businesses cannot publish or even send draft Flows ("Blocked by Integrity"): use the text PIN.
      setEnv({ OPERATOR_PIN_FLOW_ID: id, OPERATOR_PIN_FLOW_MODE: 'text' });
      log.warn(
        `could not publish (${err instanceof Error ? err.message : String(err)}); using the text PIN for now. Re-run this step after business verification.`,
      );
      return;
    }
    setEnv({ OPERATOR_PIN_FLOW_ID: id });
    log.ok(`Flow ${id} published`);
  },

  async templates() {
    if (channel() !== 'whatsapp') return;
    log.step('Message templates (for when the 24-hour window is closed)');
    const e = readEnv();
    const lang = e.OPERATOR_REPLY_TEMPLATE_LANG ?? 'en';
    const list: [string, string][] = [
      ['operator_result_ready', 'Your task on the business PC has a result. Reply to this message to see it.'],
      ['operator_pc_offline', 'The business PC is not responding. Operator Mode is offline until it is back.'],
      ['operator_pc_online', 'The business PC is back online.'],
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
    run(process.execPath, [path.join(ROOT, 'dist', 'bin', 'cli.js'), 'set-pin']);
  },

  async voice() {
    log.step('Voice notes (speech to text on this PC, whisper.cpp)');
    const e = readEnv();
    if (
      !(await confirm(
        e.WHISPER_MODEL
          ? 'Voice notes are set up. Check or repair them?'
          : 'Set up voice notes? (downloads about 500 MB)',
        !e.WHISPER_MODEL,
      ))
    )
      return;
    const lang = await ask('Spoken language: auto (any), bn (Bangla) or en', e.WHISPER_LANG ?? 'auto');
    const t = await installVoice(STATE, 'small', (s) => log.ok(s));
    setEnv({ WHISPER_BIN: t.bin, WHISPER_MODEL: t.model, FFMPEG_BIN: t.ffmpeg, WHISPER_LANG: lang });
    log.ok(`voice notes on; the service starts whisper itself (restart it: ${RESTART})`);
  },

  async browser() {
    log.step('Browser control (Claude in Chrome extension)');
    const e = readEnv();
    console.log('  Lets the operator use Chrome on this PC: open sites, fill forms, read pages.');
    console.log('  It uses the real Chrome profile, so it can see sites you are logged in to.');
    console.log('  Every browser action still asks the owner for approval on WhatsApp.');
    if (
      !(await confirm(
        e.OPERATOR_BROWSER === 'true' ? 'Browser control is on. Keep it on?' : 'Turn on browser control?',
        e.OPERATOR_BROWSER === 'true',
      ))
    ) {
      setEnv({ OPERATOR_BROWSER: 'false' });
      log.ok('browser control off');
      return;
    }
    const store = 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';
    if (WIN) run('cmd', ['/c', 'start', 'chrome', store], { quiet: true });
    else run(MAC ? 'open' : 'xdg-open', MAC ? ['-a', 'Google Chrome', store] : [store], { quiet: true });
    console.log('  Chrome opened the extension page. In Chrome:');
    console.log('    1. Click "Add to Chrome", then "Add extension".');
    console.log('    2. Click the Claude icon and sign in with the same Claude account as this PC.');
    console.log(`  If Chrome did not open, open this page yourself: ${store}`);
    await ask('Press Enter when the extension is added and signed in', '');
    setEnv({ OPERATOR_BROWSER: 'true' });
    log.ok(`browser control on (restart the service: ${RESTART}). Keep Chrome open for it to work.`);
  },

  async tunnel() {
    if (channel() !== 'whatsapp') return;
    log.step('Cloudflare tunnel (public URL for the webhook)');
    console.log('  1. quick  - free trycloudflare.com URL, no domain needed. Changes on every restart;');
    console.log('              the service re-registers the webhook automatically each time.');
    console.log('  2. named  - your own stable hostname (needs a domain on Cloudflare). Best for daily use.');
    const mode =
      (await ask('Choose 1 (quick) or 2 (named)', readEnv().TUNNEL_MODE === 'named' ? '2' : '1')) === '2'
        ? 'named'
        : 'quick';
    if (!has('cloudflared')) {
      if (WIN) {
        console.log('  Installing cloudflared with winget…');
        run('winget', [
          'install',
          '--id',
          'Cloudflare.cloudflared',
          '-e',
          '--accept-source-agreements',
          '--accept-package-agreements',
        ]);
      } else if (MAC && has('brew')) {
        console.log('  Installing cloudflared with Homebrew…');
        run('brew', ['install', 'cloudflared']);
      } else {
        throw new Error(
          `cloudflared is not installed. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then re-run: ${SETUP} --only tunnel`,
        );
      }
      if (!has('cloudflared'))
        throw new Error(`cloudflared not found after install. Open a new terminal and re-run: ${SETUP} --only tunnel`);
    }
    const bin = which('cloudflared');
    if (mode === 'quick') {
      setEnv({ TUNNEL_MODE: 'quick', CLOUDFLARED_BIN: bin });
      log.ok('quick tunnel: the service starts it and registers the webhook on every start');
      log.warn(
        'quick tunnels drop sometimes and change URL on restart; switch to a named tunnel once you have a domain',
      );
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
    log.step(WIN ? 'Start at logon, keep awake, lock screen at logon' : 'Start automatically, keep awake');
    const tunnelBin = readEnv().TUNNEL_MODE === 'named' ? which('cloudflared') : '';
    const notes = installAutostart({ root: ROOT, ...(tunnelBin ? { tunnelBin } : {}) });
    log.ok('registered and started');
    for (const n of notes) log.ok(n);
    const port = readEnv().WEBHOOK_PORT ?? '3100';
    if (await waitFor(`http://127.0.0.1:${port}/health/live`, 30)) log.ok('service is up');
    else log.warn(`service did not answer yet; check ${LOG_FILE}`);
  },

  async webhook() {
    if (channel() !== 'whatsapp') return;
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
        const log2 = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
        base = [...log2.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].at(-1)?.[0] ?? '';
        if (!base) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!base) throw new Error('no quick tunnel URL yet; check logs/operator.log');
    }
    if (!(await waitFor(`${base}/health/live`, 90)))
      throw new Error(`${base} is not reachable yet. Re-run: ${SETUP} --only webhook`);
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
    if (!WIN) {
      log.step('Automatic login after a reboot');
      console.log(
        MAC
          ? '  By hand: System Settings → Users & Groups → Automatically log in as (needs FileVault off).'
          : '  Not needed: the service starts at boot without a login (systemd linger).',
      );
      return;
    }
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
    if (channel() !== 'whatsapp') return;
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
  if (WIN ? spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0 : process.getuid?.() === 0)
    console.log(
      WIN
        ? '\x1b[33mRunning as admin. Scheduled tasks will still run without admin rights.\x1b[0m'
        : '\x1b[33mRunning as root. Run setup as the normal user instead (no sudo).\x1b[0m',
    );
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
  };
  const only = arg('--only');
  const skip = arg('--skip');
  const flag = (f: string) => process.argv.includes(f);
  const base: readonly Step[] = only.length || !flag('--quick') ? STEPS : QUICK;
  const todo = base.filter((s) => (only.length ? only.includes(s) : true) && !skip.includes(s));
  quick = base === QUICK;
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
  if (failed.length) console.log(`Re-run the failed steps: ${SETUP} --only ${failed.join(',')}`);
  else console.log("Done. Message the operator number from the owner's phone; it will ask for the PIN.");
  console.log(
    MAC
      ? 'By hand (once): System Settings → Energy → "Start up automatically after a power failure".'
      : 'By hand (once): BIOS → "Restore on AC power loss" = Power On.',
  );
  if (quick) console.log(`More options (voice notes, browser, Cloud API…): ${SETUP}`);
  console.log(`After the first message, review MCP tools: ${CLI} tiers, then tiers accept.`);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
