import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { SECRET_NAMES, readSecrets } from '../security/secrets.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const csv = z.string().transform((v) =>
  v
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean),
);
const digits = z.string().regex(/^\d+$/, 'must be numeric');

/** Friendly CHANNEL names → channel IDs. */
export const CHANNEL_ALIASES: Record<string, 'whatsapp' | 'baileys'> = { linked: 'baileys', cloud: 'whatsapp' };

const EnvSchema = z
  .object({
    /** Which chat app the owner uses. Telegram is the one-setting fallback if Meta's AI policy tightens. */
    // Setting names: linked (WhatsApp linked device), cloud (Meta Cloud API), telegram. The older
    // names baileys and whatsapp still work; inside the app they stay the channel IDs.
    CHANNEL: z.preprocess(
      (v) => (typeof v === 'string' ? (CHANNEL_ALIASES[v.trim().toLowerCase()] ?? v.trim().toLowerCase()) : v),
      z.enum(['whatsapp', 'telegram', 'baileys']).default('whatsapp'),
    ),

    // The one user
    /** The owner's personal WhatsApp number (wa_id: country code + number, digits only). */
    OPERATOR_WA_ID: z
      .string()
      .regex(/^\d{7,15}$/, 'digits only, e.g. 8801712345678')
      .optional(),
    OPERATOR_ENABLED: bool.default(true),
    /** Optional argon2 hash; normally set with `wa-operator set-pin` and kept in the database. */
    OPERATOR_PIN_HASH: z.string().startsWith('$argon2').optional(),
    /** Folders Claude may change files in. Reads outside them need a tap. */
    OPERATOR_ROOTS: csv.pipe(z.array(z.string()).min(1, 'set at least one work folder')),
    /** Claude's working directory. Defaults to <first root>/WA Operator. */
    OPERATOR_HOME: z.string().optional(),
    /** Where photos and PDFs from the owner are saved. Defaults to <home>/Inbox. */
    OPERATOR_INBOX: z.string().optional(),
    /** Where Claude puts files it sends back. Defaults to <home>/Outbox. */
    OPERATOR_OUTBOX: z.string().optional(),
    OPERATOR_IDLE_MIN: int(1, 24 * 60).default(30),
    OPERATOR_MODEL: z.string().min(1).max(80).default('opus'),
    /** Model for short, simple requests (screenshot, a quick read). "off" uses OPERATOR_MODEL for everything. */
    OPERATOR_FAST_MODEL: z.string().min(1).max(80).default('sonnet'),
    /** Only these Claude Desktop / config/mcp.json servers load (comma separated). Empty = all. */
    OPERATOR_MCP_ALLOW: csv.default([]),
    /** Start a fresh conversation when the last task ended this many minutes ago (0 = only at midnight). */
    OPERATOR_FRESH_AFTER_MIN: int(0, 24 * 60).default(120),
    OPERATOR_MAX_TURNS: int(1, 500).default(40),
    /** Tasks that may run at the same time (each in its own Claude session). */
    OPERATOR_PARALLEL: int(1, 4).default(2),
    OPERATOR_APPROVAL_TTL_SECONDS: int(30, 3600).default(300),
    OPERATOR_PROGRESS_SECONDS: int(5, 600).default(30),
    /** Extra paths that are always blocked (comma separated). */
    OPERATOR_EXTRA_DENY: csv.default([]),
    /** Operator Mode refuses to run elevated unless this is set. */
    OPERATOR_ALLOW_ADMIN: bool.default(false),
    // Claude in Chrome: lets the operator drive the owner's real Chrome (every action still needs approval).
    OPERATOR_BROWSER: bool.default(false),
    /** WhatsApp Flow with a password field, used for the PIN (config/flows/pin-flow.json). */
    OPERATOR_PIN_FLOW_ID: digits.optional(),
    /** draft = send the unpublished Flow (testing, or until the business passes Meta's integrity check). */
    OPERATOR_PIN_FLOW_MODE: z.enum(['published', 'draft', 'text']).default('published'),
    /** Utility template used when a result is ready after the 24-hour window closed. */
    OPERATOR_REPLY_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    OPERATOR_REPLY_TEMPLATE_LANG: z.string().default('en'),
    /** Optional whisper.cpp server (e.g. http://127.0.0.1:8178) for real voice notes. */
    WHISPER_URL: z.url().optional(),
    /** whisper-server program and model: the service starts it itself (set by `npm run setup -- --only voice`). */
    WHISPER_BIN: z.string().optional(),
    WHISPER_MODEL: z.string().optional(),
    WHISPER_PORT: int(1, 65535).default(8178),
    /** Spoken language: auto, or a code like bn / en. */
    WHISPER_LANG: z.string().default('auto'),
    /** ffmpeg (WhatsApp voice notes are OGG/Opus), if it is not on PATH. */
    FFMPEG_BIN: z.string().optional(),

    // Business (scope guard)
    BUSINESS_NAME: z.string().min(1).max(100).default('the business'),
    BUSINESS_DESCRIPTION: z.string().max(500).default(''),
    BUSINESS_TIMEZONE: z.string().default('Asia/Dhaka'),

    // Claude subscription (from `claude setup-token`; kept in the system secret store)
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20).optional(),

    /** Data encryption key (64 hex). Made automatically and kept in the system secret store. */
    OPERATOR_DATA_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/, '64 hex characters')
      .optional(),

    // WhatsApp Cloud API
    META_APP_SECRET: z.string().min(16).optional(),
    META_VERIFY_TOKEN: z.string().min(32, 'use a random value of at least 32 characters').optional(),
    META_APPSECRET_PROOF: bool.default(true),
    WHATSAPP_ACCESS_TOKEN: z.string().min(20).optional(),
    WHATSAPP_PHONE_NUMBER_ID: digits.optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: digits.optional(),
    META_APP_ID: digits.optional(),
    /**
     * quick = free trycloudflare.com tunnel started by the service; its URL changes on every start, so the
     * webhook is re-registered automatically. named = your own stable hostname (PUBLIC_HOSTNAME). none = bring your own.
     */
    TUNNEL_MODE: z.enum(['quick', 'named', 'none']).default('none'),
    PUBLIC_HOSTNAME: z.string().optional(),
    /** Path to cloudflared if it is not on PATH. */
    CLOUDFLARED_BIN: z.string().optional(),
    WHATSAPP_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, 'format vNN.N')
      .default('v24.0'),
    WHATSAPP_GRAPH_BASE_URL: z.url().default('https://graph.facebook.com'),

    // Telegram fallback
    TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
    TELEGRAM_OPERATOR_USER_ID: digits.optional(),
    TELEGRAM_API_BASE_URL: z.url().default('https://api.telegram.org'),

    // Baileys (WhatsApp linked device; unofficial, use a spare number)
    /** Where the linked-device session is kept. Defaults to <DATA_DIR>/baileys-auth. Treat it like a password. */
    BAILEYS_AUTH_DIR: z.string().optional(),

    // Storage and service
    DATA_DIR: z.string().default('./data'),
    MEDIA_MAX_BYTES: int(1, 100 * 1024 * 1024).default(25 * 1024 * 1024),
    WEBHOOK_HOST: z.string().default('127.0.0.1'),
    WEBHOOK_PORT: int(1, 65535).default(3100),
    WEBHOOK_PATH: z.string().startsWith('/').default('/webhooks/whatsapp'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_FILE: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const need = (keys: (keyof typeof v)[], why: string) => {
      for (const k of keys) if (!v[k]) ctx.addIssue({ code: 'custom', path: [k], message: `required ${why}` });
    };
    if (v.CHANNEL === 'whatsapp') {
      need(
        ['OPERATOR_WA_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
        'when CHANNEL=cloud',
      );
    } else if (v.CHANNEL === 'baileys') {
      need(['OPERATOR_WA_ID'], 'when CHANNEL=linked');
    } else {
      need(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OPERATOR_USER_ID'], 'when CHANNEL=telegram');
    }
  });

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Config extends RawEnv {
  baseDir: string;
  /** Install folder of this app (always blocked for Claude). */
  appDir: string;
  dataDir: string;
  databasePath: string;
  logFile: string | undefined;
  roots: string[];
  home: string;
  inbox: string;
  outbox: string;
  /** Fixed folders inside home where Claude files documents, records and notes. */
  folders: { clients: string; reports: string; records: string; notes: string };
  graphBaseUrl: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Expand ~ and %VAR% so roots can be written the way people type them. */
export function expandPath(p: string, baseDir: string): string {
  let out = p.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m);
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(baseDir, out);
}

/** Build a validated, frozen config from an env-like record. Pure apart from path expansion. */
export function buildConfig(env: Record<string, string | undefined>, baseDir: string, appDir = baseDir): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const raw = parsed.data;
  const resolve = (p: string) => expandPath(p, baseDir);
  const roots = raw.OPERATOR_ROOTS.map(resolve);
  const home = raw.OPERATOR_HOME ? resolve(raw.OPERATOR_HOME) : path.join(roots[0]!, 'WA Operator');
  const dataDir = resolve(raw.DATA_DIR);
  return Object.freeze({
    ...raw,
    baseDir,
    appDir,
    dataDir,
    databasePath: path.join(dataDir, 'operator.db'),
    logFile: raw.LOG_FILE ? resolve(raw.LOG_FILE) : undefined,
    roots,
    home,
    inbox: raw.OPERATOR_INBOX ? resolve(raw.OPERATOR_INBOX) : path.join(home, 'Inbox'),
    outbox: raw.OPERATOR_OUTBOX ? resolve(raw.OPERATOR_OUTBOX) : path.join(home, 'Outbox'),
    folders: {
      clients: path.join(home, 'Clients'),
      reports: path.join(home, 'Reports'),
      records: path.join(home, 'Records'),
      notes: path.join(home, 'Notes'),
    },
    graphBaseUrl: `${raw.WHATSAPP_GRAPH_BASE_URL.replace(/\/$/, '')}/${raw.WHATSAPP_API_VERSION}`,
  });
}

/**
 * Load config from `DOTENV_CONFIG_PATH` (or `./.env`), then real environment variables, then secrets
 * from the system secret store: Credential Manager, Keychain or keyring (which win, so tokens never need to sit in `.env`).
 */
export function loadConfig(opts: { secrets?: boolean } = {}): Config {
  const envPath = envFilePath();
  const fileVars = fs.existsSync(envPath) ? parseDotenv(fs.readFileSync(envPath)) : {};
  const baseDir = path.dirname(envPath);
  const secrets = opts.secrets === false ? {} : readSecrets(SECRET_NAMES);
  return buildConfig({ ...fileVars, ...process.env, ...secrets }, baseDir, appRoot());
}

/** The folder holding package.json, from both src/ (tsx) and dist/ (built). */
export function appRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

/** True when running from a downloaded release (the installer writes this marker), not a git checkout. */
export function isInstalled(): boolean {
  return fs.existsSync(path.join(appRoot(), '.installed'));
}

/**
 * Where this PC's own files live: .env, data/, logs/, tools/, config/mcp.json.
 * Installed: %APPDATA%wa-operator, ~/Library/Application Support/wa-operator or ~/.config/wa-operator,
 * so an update can replace the app folder without touching them. Git checkout: the repo folder, as before.
 */
export function stateDir(): string {
  if (process.env.WAOP_STATE_DIR) return path.resolve(process.env.WAOP_STATE_DIR);
  if (!isInstalled()) return appRoot();
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return path.join(base, 'wa-operator');
}

/** The .env in use: DOTENV_CONFIG_PATH, or <stateDir>/.env. */
export function envFilePath(): string {
  return path.resolve(process.env.DOTENV_CONFIG_PATH ?? path.join(stateDir(), '.env'));
}

/** How to type a command here: "wa-operator setup --only x" installed, "npm run setup -- --only x" in a checkout. */
export function hint(cmd: string): string {
  if (isInstalled()) return `wa-operator ${cmd}`;
  const [name, ...rest] = cmd.split(' ');
  if (name === 'start') return 'npm start';
  return `npm run ${name}${rest.length ? ` -- ${rest.join(' ')}` : ''}`;
}
