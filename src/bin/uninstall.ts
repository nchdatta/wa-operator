#!/usr/bin/env node
/**
 * Undo `npm run setup`.
 *   npm run uninstall                 stop the service, remove tasks, webhook override and secrets (keeps .env and data)
 *   npm run uninstall -- --purge      also delete data/, logs/ and dist/ (.env is never deleted) (uninstall.cmd also removes node_modules)
 *   npm run uninstall -- --yes        no questions
 *   npm run uninstall -- --keep-secrets   leave the Credential Manager entries (for a reinstall)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { appRoot } from '../config/env.js';
import { MetaClient } from '../meta/client.js';
import { silentLogger } from '../observability/logger.js';
import { deleteSecret, readSecrets, SECRET_NAMES } from '../security/secrets.js';
import { confirm } from '../shared/prompt.js';
import { purgePaths } from '../shared/purge.js';

process.noDeprecation = true;

const ROOT = appRoot();
const ENV_PATH = path.join(ROOT, '.env');
const TASKS = ['WhatsApp Operator Mode', 'WhatsApp Operator Tunnel', 'WhatsApp Operator Lock'];
const TUNNEL = 'wa-operator';
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const purge = args.includes('--purge');
const keepSecrets = args.includes('--keep-secrets');

const log = {
  step: (s: string) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`),
  ok: (s: string) => console.log(`  \x1b[32m✔\x1b[0m ${s}`),
  warn: (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`),
};
const ask = (q: string, def = true) => (yes ? Promise.resolve(def) : confirm(q, def));

function ps(script: string) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    input: script,
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function stopService(): void {
  log.step('Stop the service and remove scheduled tasks');
  for (const t of TASKS) {
    const r = ps(`$t = Get-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue
if ($t) { Stop-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${t}' -Confirm:$false; 'removed' }`);
    if (r.out.includes('removed')) log.ok(`task "${t}" removed`);
  }
  // A manual `npm run dev` or the quick tunnel child may still run from this folder.
  const dir = ROOT.replace(/'/g, "''");
  const r = ps(`Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*${dir}*service*' -and $_.ProcessId -ne ${process.pid}) -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*--url http://127.0.0.1*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.Name }`);
  if (r.out) log.ok(`stopped: ${r.out.split(/\r?\n/).join(', ')}`);
}

async function removeWebhook(env: Record<string, string>, s: Record<string, string>): Promise<void> {
  if (env.CHANNEL === 'telegram' || !env.WHATSAPP_BUSINESS_ACCOUNT_ID) return;
  log.step('Remove the webhook override (the app stays subscribed, so other projects keep working)');
  if (!s.WHATSAPP_ACCESS_TOKEN || !s.META_APP_SECRET) {
    log.warn('no Meta credentials in Credential Manager; skipped');
    return;
  }
  const client = new MetaClient({
    baseUrl: `https://graph.facebook.com/${env.WHATSAPP_API_VERSION ?? 'v24.0'}`,
    accessToken: s.WHATSAPP_ACCESS_TOKEN,
    appSecret: s.META_APP_SECRET,
    appsecretProof: true,
    logger: silentLogger,
  });
  try {
    // Subscribing without override_callback_uri clears the override.
    await client.request({ method: 'POST', path: `/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps` });
    log.ok(`override cleared for account ${env.WHATSAPP_BUSINESS_ACCOUNT_ID}`);
  } catch (e) {
    log.warn(`could not clear it: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function removeTunnel(env: Record<string, string>): Promise<void> {
  if (env.TUNNEL_MODE !== 'named') return;
  if (!(await ask(`Delete the named Cloudflare tunnel "${TUNNEL}"? (DNS record ${env.PUBLIC_HOSTNAME} stays)`, true)))
    return;
  const bin = env.CLOUDFLARED_BIN || 'cloudflared';
  const r = spawnSync(bin, ['tunnel', 'delete', '-f', TUNNEL], { encoding: 'utf8' });
  if (r.status === 0) log.ok(`tunnel ${TUNNEL} deleted`);
  else log.warn(`tunnel not deleted: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
}

function removeSecrets(): void {
  log.step('Remove secrets from Windows Credential Manager');
  let n = 0;
  for (const name of SECRET_NAMES) {
    // The data key goes only with the data: without it the kept database could never be read again.
    if (name === 'OPERATOR_DATA_KEY' && !purge) continue;
    if (deleteSecret(name)) n++;
  }
  log.ok(`${n} removed${purge ? '' : ' (data key kept with data/)'}`);
}

function purgeFiles(): void {
  log.step('Delete local files');
  for (const full of purgePaths(ROOT)) {
    const p = path.basename(full);
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      log.ok(`${p} deleted`);
    } catch (e) {
      log.warn(`${p} not deleted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run uninstall -- [--purge] [--yes] [--keep-secrets]');
    return;
  }
  console.log(`WhatsApp Operator Mode uninstall (${ROOT})`);
  if (purge) console.log('  --purge: data (PIN, history, tool tiers), logs and dist will be deleted. .env is kept.');
  if (!(await ask('Continue?', true))) return;

  const env = fs.existsSync(ENV_PATH) ? parseDotenv(fs.readFileSync(ENV_PATH)) : {};
  const secrets = readSecrets(SECRET_NAMES);

  stopService();
  await removeWebhook(env, secrets);
  await removeTunnel(env);
  if (!keepSecrets && (await ask('Delete the saved Meta/Claude secrets?', true))) removeSecrets();
  if (purge) purgeFiles();

  console.log('\nDone. Not changed (undo by hand if you want):');
  console.log('  - Sleep settings: powercfg /change standby-timeout-ac 30');
  console.log('  - Autologon: run Autologon64.exe from Sysinternals and click Disable');
  console.log('  - Meta: the PIN Flow and the reply template stay in WhatsApp Manager');
  console.log(`  - .env kept${purge ? '' : ' with data/'}. Reinstall with: install.cmd`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
