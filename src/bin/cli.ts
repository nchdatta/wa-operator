#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { parse as parseDotenv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { recentAudit } from '../audit.js';
import { appRoot, ConfigError, expandPath, loadConfig, type Config } from '../config/env.js';
import type { AppContext } from '../context.js';
import { MetaClient } from '../meta/client.js';
import { silentLogger } from '../observability/logger.js';
import { Gate } from '../operator/gate.js';
import { desktopConfigPaths } from '../operator/session.js';
import { isTier, TIERS } from '../operator/tier.js';
import { openDb } from '../persistence/db.js';
import { toolTiers } from '../persistence/schema.js';
import { deleteSecret, readSecrets, SECRET_NAMES, writeSecret, type SecretName } from '../security/secrets.js';
import { systemClock } from '../shared/clock.js';

/**
 * PC-side controls. Everything that loosens security (PIN, enable after lockout, tiers, secrets)
 * happens here, at the PC, never from WhatsApp.
 */

function envFile(): { vars: Record<string, string>; baseDir: string } {
  const envPath = path.resolve(process.env.DOTENV_CONFIG_PATH ?? '.env');
  const exists = fs.existsSync(envPath);
  return {
    vars: { ...(exists ? parseDotenv(fs.readFileSync(envPath)) : {}), ...(process.env as Record<string, string>) },
    baseDir: exists ? path.dirname(envPath) : process.cwd(),
  };
}

/** A context good enough for database commands, without needing every secret to be set yet. */
function dbContext(): AppContext {
  const { vars, baseDir } = envFile();
  const dataDir = expandPath(vars.DATA_DIR ?? './data', baseDir);
  const config = {
    OPERATOR_ENABLED: vars.OPERATOR_ENABLED !== 'false',
    OPERATOR_IDLE_MIN: Number(vars.OPERATOR_IDLE_MIN ?? 30),
    OPERATOR_PIN_HASH: vars.OPERATOR_PIN_HASH,
    BUSINESS_TIMEZONE: vars.BUSINESS_TIMEZONE ?? 'Asia/Dhaka',
    dataDir,
    databasePath: path.join(dataDir, 'operator.db'),
  } as unknown as Config;
  return { config, db: openDb(config.databasePath), logger: silentLogger, clock: systemClock, secrets: [] };
}

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]!.trim();
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (raw: string) => {
      // Drop terminal escape sequences (focus events, device replies) that arrive in raw mode.
      // eslint-disable-next-line no-control-regex
      const ch = raw.replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|[@-Z\-_])/g, '');
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          done();
          return resolve(value);
        }
        if (c === '\u0003') {
          done();
          return reject(new Error('cancelled'));
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    process.stdin.on('data', onData);
  });
}

const program = new Command();
program.name('wa-operator').description('WhatsApp Operator Mode: PC-side controls').version('0.1.0');

program
  .command('set-pin')
  .description('Set or change the PIN (4–12 digits). Also clears failed attempts and locks until the next PIN.')
  .action(async () => {
    const pin = await readHidden('New PIN: ');
    const again = process.stdin.isTTY ? await readHidden('Repeat PIN: ') : pin;
    if (pin !== again) throw new Error('The two PINs differ.');
    await new Gate(dbContext()).setPin(pin);
    console.log('PIN saved.');
  });

program
  .command('enable')
  .description('Turn Operator Mode on (also the only way out of a 3-wrong-PIN lockout).')
  .action(() => {
    new Gate(dbContext()).enable();
    console.log('Operator Mode enabled. The owner unlocks it with the PIN from WhatsApp.');
  });

program
  .command('disable')
  .description('Turn Operator Mode off. Messages from the owner get a "turned off" reply.')
  .action(() => {
    new Gate(dbContext()).disable();
    console.log('Operator Mode disabled.');
  });

program
  .command('status')
  .description('Show gate state.')
  .action(() => {
    const gate = new Gate(dbContext());
    const s = gate.state();
    console.log(
      JSON.stringify(
        {
          enabled: s.enabled,
          disabledReason: s.disabledReason,
          pinSet: gate.hasPin(),
          unlocked: gate.isUnlocked(),
          unlockedUntil: s.unlockedUntil ? new Date(s.unlockedUntil).toISOString() : null,
          failedPins: s.failedPins,
          trusted: s.trusted,
        },
        null,
        2,
      ),
    );
  });

const tiers = program.command('tiers').description('Confirm or change the tier of MCP tools.');
tiers
  .command('list', { isDefault: true })
  .description('List MCP tools seen so far with their confirmed or suggested tier.')
  .action(() => {
    const rows = dbContext().db.select().from(toolTiers).orderBy(toolTiers.toolName).all();
    if (!rows.length) return console.log('No MCP tools seen yet. Start the service once so the session can list them.');
    for (const r of rows) console.log(`${(r.tier ?? `(${r.suggested}?)`).padEnd(12)} ${r.toolName}`);
    console.log(
      '\n(TIER?) = not confirmed yet, runs as HIGH. Confirm with "tiers accept" or "tiers set <tool> <tier>".',
    );
  });
tiers
  .command('set <tool> <tier>')
  .description(`Set a tool's tier: ${TIERS.join(', ')}.`)
  .action((tool: string, tier: string) => {
    const t = tier.toUpperCase();
    if (!isTier(t)) throw new Error(`Tier must be one of ${TIERS.join(', ')}.`);
    const ctx = dbContext();
    const now = Date.now();
    ctx.db
      .insert(toolTiers)
      .values({ toolName: tool, tier: t, suggested: t, firstSeenAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: toolTiers.toolName, set: { tier: t, updatedAt: now } })
      .run();
    console.log(`${tool} → ${t}`);
  });
tiers
  .command('accept')
  .description('Accept the suggested tier for every unconfirmed tool (review the list first).')
  .action(() => {
    const ctx = dbContext();
    const rows = ctx.db
      .select()
      .from(toolTiers)
      .all()
      .filter((r) => !r.tier);
    for (const r of rows)
      ctx.db
        .update(toolTiers)
        .set({ tier: r.suggested as never, updatedAt: Date.now() })
        .where(eq(toolTiers.toolName, r.toolName))
        .run();
    console.log(`Confirmed ${rows.length} tool(s).`);
  });
tiers
  .command('reset <tool>')
  .description('Forget the confirmed tier (the tool runs as HIGH again).')
  .action((tool: string) => {
    dbContext()
      .db.update(toolTiers)
      .set({ tier: null, updatedAt: Date.now() })
      .where(eq(toolTiers.toolName, tool))
      .run();
    console.log(`${tool} reset.`);
  });

program
  .command('logs')
  .description('Show the latest audit log entries.')
  .option('-n, --limit <n>', 'number of entries', '30')
  .action((o: { limit: string }) => {
    for (const r of recentAudit(dbContext(), Number(o.limit)).reverse()) {
      console.log(
        `${new Date(r.createdAt).toISOString()}  ${r.actor.padEnd(8)} ${r.action.padEnd(22)} ${r.outcome}${r.metadataJson ? `  ${r.metadataJson}` : ''}`,
      );
    }
  });

const secret = program.command('secret').description('Secrets in Windows Credential Manager.');
secret
  .command('set <name>')
  .description(`Store a secret (${SECRET_NAMES.join(', ')}). The value is read hidden from the terminal or stdin.`)
  .action(async (name: string) => {
    if (!(SECRET_NAMES as readonly string[]).includes(name))
      throw new Error(`Unknown secret. Use one of ${SECRET_NAMES.join(', ')}.`);
    const value = await readHidden(`${name}: `);
    if (value.length < 8) throw new Error('That value looks too short.');
    writeSecret(name as SecretName, value);
    console.log(`${name} saved to Credential Manager.`);
  });
secret
  .command('list')
  .description('Show which secrets are stored (never their values).')
  .action(() => {
    const found = readSecrets(SECRET_NAMES);
    for (const n of SECRET_NAMES) console.log(`${found[n] ? '✔' : '✘'} ${n}`);
  });
secret.command('delete <name>').action((name: string) => {
  console.log(deleteSecret(name as SecretName) ? `${name} deleted.` : `${name} was not stored.`);
});

program
  .command('import-desktop-mcp')
  .description(
    "Snapshot Claude Desktop's MCP servers into config/mcp.json (optional: they are also read live at start).",
  )
  .action(() => {
    const src = desktopConfigPaths()[0];
    if (!src) throw new Error('claude_desktop_config.json not found (classic or Microsoft Store install)');
    const desktop = JSON.parse(fs.readFileSync(src, 'utf8')) as { mcpServers?: Record<string, unknown> };
    const servers = desktop.mcpServers ?? {};
    const out = path.join(appRoot(), 'config', 'mcp.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ mcpServers: servers }, null, 2));
    console.log(
      `Imported ${Object.keys(servers).length} server(s) into ${out}: ${Object.keys(servers).join(', ') || '(none)'}`,
    );
    console.log('Restart the service, then review their tools with "wa-operator tiers".');
  });

program
  .command('check')
  .description('Validate the configuration and reach the chat app.')
  .action(async () => {
    let config: Config;
    try {
      config = loadConfig();
    } catch (e) {
      throw new Error(e instanceof ConfigError ? e.message : String(e), { cause: e });
    }
    console.log(`✔ config OK (channel ${config.CHANNEL}, roots ${config.roots.join(', ')})`);
    console.log(
      `${config.CLAUDE_CODE_OAUTH_TOKEN ? '✔' : '!'} Claude subscription token ${config.CLAUDE_CODE_OAUTH_TOKEN ? 'stored' : 'not stored (claude setup-token, then secret set)'}`,
    );
    if (config.CHANNEL === 'whatsapp') {
      const client = new MetaClient({
        baseUrl: config.graphBaseUrl,
        accessToken: config.WHATSAPP_ACCESS_TOKEN!,
        appSecret: config.META_APP_SECRET!,
        appsecretProof: config.META_APPSECRET_PROOF,
        logger: silentLogger,
      });
      const info = await client.request<{ display_phone_number?: string; verified_name?: string }>({
        method: 'GET',
        path: `/${config.WHATSAPP_PHONE_NUMBER_ID}`,
        query: { fields: 'display_phone_number,verified_name' },
      });
      console.log(`✔ WhatsApp number ${info.display_phone_number ?? '?'} (${info.verified_name ?? '?'})`);
      console.log(
        `${config.OPERATOR_PIN_FLOW_ID ? '✔' : '✘'} PIN Flow ${config.OPERATOR_PIN_FLOW_ID ?? 'not set (OPERATOR_PIN_FLOW_ID)'}`,
      );
      console.log(
        `${config.OPERATOR_REPLY_TEMPLATE ? '✔' : '!'} 24-hour template ${config.OPERATOR_REPLY_TEMPLATE ?? 'not set (results after 24 h are held)'}`,
      );
    } else {
      const res = await fetch(`${config.TELEGRAM_API_BASE_URL}/bot${config.TELEGRAM_BOT_TOKEN}/getMe`);
      const body = (await res.json()) as { ok: boolean; result?: { username?: string } };
      if (!body.ok) throw new Error('Telegram rejected the bot token.');
      console.log(`✔ Telegram bot @${body.result?.username}`);
    }
    const gate = new Gate(dbContext());
    console.log(`${gate.hasPin() ? '✔' : '✘'} PIN ${gate.hasPin() ? 'set' : 'not set (wa-operator set-pin)'}`);
  });

program.parseAsync().catch((e: unknown) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
