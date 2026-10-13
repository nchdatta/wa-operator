import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  isJidStatusBroadcast,
  isJidBroadcast,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from 'baileys';
import type { Config } from '../config/env.js';
import type { Logger } from '../observability/logger.js';
import { truncate } from '../security/redact.js';
import { MINUTE } from '../shared/clock.js';
import type { Button, Channel, ListRow, MediaKind, OwnerMessage } from './channel.js';
import { mimeFor } from './mime.js';

/**
 * WhatsApp through a linked device (Baileys, the WhatsApp Web protocol). No Meta app, no webhook,
 * no tunnel, no 24-hour window. Unofficial: it can get the number banned, so use a spare number.
 *
 * Differences from the Cloud API channel: buttons and lists are numbered text (the owner replies
 * with the number), and the PIN is a text reply (WhatsApp cannot delete the owner's message for them).
 */

const MENU_TTL = 10 * MINUTE;
const PIN_PROMPT_TTL = 5 * MINUTE;
const CACHE_MAX = 500;

/** Digits of a user JID ("8801…@s.whatsapp.net" → "8801…"). */
function userOf(jid: string | null | undefined): string {
  return (jid ?? '').split('@')[0]!.split(':')[0]!;
}

export function baileysAuthDir(config: Config): string {
  return config.BAILEYS_AUTH_DIR
    ? path.resolve(config.baseDir, config.BAILEYS_AUTH_DIR)
    : path.join(config.dataDir, 'baileys-auth');
}

/** Baileys wants a pino-like logger; give it a quiet child of ours. */
function socketLogger(logger: Logger) {
  const child = logger.child({ mod: 'baileys' });
  child.level = 'warn';
  return child;
}

export interface BaileysConnectOpts {
  /** Called with each QR string while not linked. */
  onQr?: (qr: string) => void;
  /** Phone number (digits) to link by pairing code instead of QR. */
  pairPhone?: string;
  onPairingCode?: (code: string) => void;
}

export class BaileysChannel implements Channel {
  readonly name = 'baileys' as const;
  readonly maxText = 4096;
  private sock: WASocket | null = null;
  private stopped = false;
  private ready: Promise<void>;
  private markReady!: () => void;
  /** Recent messages by ID: for quoting, reactions and media downloads. */
  private readonly cache = new Map<string, WAMessage>();
  /** Last numbered menu: option number → button/row ID. */
  private menu: { ids: string[]; at: number; messageId: string | null } | null = null;
  private readonly pinPrompts = new Map<string, { token: string; at: number }>();
  /** Set when connected; receives every new message from the owner chat. */
  onMessage: ((m: WAMessage) => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.ready = new Promise((r) => (this.markReady = r));
  }

  private get jid(): string {
    return `${this.config.OPERATOR_WA_ID}@s.whatsapp.net`;
  }

  /** Connect (and keep reconnecting) until stop(). Resolves once linked and open. */
  async connect(opts: BaileysConnectOpts = {}): Promise<void> {
    const dir = baileysAuthDir(this.config);
    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: socketLogger(this.logger),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => (key.id ? this.cache.get(key.id)?.message : undefined) ?? undefined,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    if (opts.pairPhone && !state.creds.registered) {
      // The socket must be up before a pairing code can be requested.
      setTimeout(() => {
        sock
          .requestPairingCode(opts.pairPhone!)
          .then((code) => opts.onPairingCode?.(code))
          .catch((e: unknown) => this.logger.error({ err: String(e) }, 'baileys: pairing code failed'));
      }, 3000);
    }

    sock.ev.on('connection.update', (u) => {
      if (u.qr && !opts.pairPhone) opts.onQr?.(u.qr);
      if (u.connection === 'open') {
        this.logger.info({ me: userOf(sock.user?.id) }, 'baileys: connected');
        this.markReady();
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (this.stopped) return;
        if (code === DisconnectReason.loggedOut) {
          this.logger.fatal('baileys: this device was logged out. Link it again: wa-operator baileys link');
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          this.logger.error('baileys: another session took over this link (is a second copy running?)');
          return;
        }
        this.logger.warn({ code }, 'baileys: connection closed, reconnecting');
        setTimeout(() => void this.connect(opts), code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const jid = m.key.remoteJid ?? '';
        if (m.key.fromMe || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) continue;
        if (m.key.id) this.remember(m);
        this.onMessage?.(m);
      }
    });

    return this.ready;
  }

  stop(): void {
    this.stopped = true;
    this.sock?.end(undefined);
  }

  private async socket(): Promise<WASocket> {
    await this.ready;
    return this.sock!;
  }

  private remember(m: WAMessage): void {
    this.cache.set(m.key.id!, m);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }

  private async send(content: Parameters<WASocket['sendMessage']>[1], replyTo?: string): Promise<string | null> {
    const sock = await this.socket();
    const quoted = replyTo ? this.cache.get(replyTo) : undefined;
    const sent = await sock.sendMessage(this.jid, content, quoted ? { quoted } : {});
    if (sent?.key.id) this.remember(sent);
    return sent?.key.id ?? null;
  }

  sendText(text: string, opts: { replyTo?: string } = {}): Promise<string | null> {
    return this.send({ text }, opts.replyTo);
  }

  /** No native buttons on linked devices: a numbered menu the owner answers with the number. */
  private async sendMenu(
    body: string,
    items: { id: string; title: string; description?: string }[],
    footer?: string,
    replyTo?: string,
  ) {
    const lines = items.map((b, i) => `*${i + 1}.* ${b.title}${b.description ? ` — ${b.description}` : ''}`);
    const text = [body, '', ...lines, '', footer ?? '', '_Reply with the number._']
      .filter((l, i, a) => l || a[i - 1])
      .join('\n');
    const id = await this.send({ text: text.trim() }, replyTo);
    this.menu = { ids: items.map((b) => b.id), at: Date.now(), messageId: id };
    return id;
  }

  sendButtons(body: string, buttons: Button[], opts: { footer?: string; replyTo?: string } = {}) {
    return this.sendMenu(body, buttons.slice(0, 3), opts.footer, opts.replyTo);
  }

  sendList(body: string, _buttonText: string, rows: ListRow[]) {
    return this.sendMenu(body, rows.slice(0, 10));
  }

  async sendFile(
    filePath: string,
    opts: { kind: 'document' | 'image'; caption?: string; filename?: string },
  ): Promise<string | null> {
    const data = await fs.promises.readFile(filePath);
    const filename = opts.filename ?? path.basename(filePath);
    const mimetype = mimeFor(filename);
    const caption = opts.caption ? truncate(opts.caption, 1024) : undefined;
    const photo = opts.kind === 'image' && /^image\//.test(mimetype);
    return this.send(
      photo
        ? { image: data, ...(caption ? { caption } : {}) }
        : { document: data, mimetype, fileName: filename, ...(caption ? { caption } : {}) },
    );
  }

  async requestPin(token: string, prompt: string): Promise<void> {
    const id = await this.sendText(
      `${prompt}\n\nReply to this message with your PIN, then delete your PIN message ("Delete for everyone").`,
    );
    if (id) this.pinPrompts.set(id, { token, at: Date.now() });
  }

  takeTextPin(text: string, replyToId?: string): string | null {
    const now = Date.now();
    for (const [id, p] of this.pinPrompts) if (now - p.at > PIN_PROMPT_TTL) this.pinPrompts.delete(id);
    const replied = replyToId ? this.pinPrompts.get(replyToId) : undefined;
    const open = replied ?? (/^\s*\d{4,12}\s*$/.test(text) ? [...this.pinPrompts.values()].at(-1) : undefined);
    if (!open) return null;
    for (const [id, p] of this.pinPrompts) if (p.token === open.token) this.pinPrompts.delete(id);
    return open.token;
  }

  private keyFor(messageId: string): WAMessageKey {
    return this.cache.get(messageId)?.key ?? { remoteJid: this.jid, id: messageId, fromMe: false };
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await this.send({ react: { text: emoji, key: this.keyFor(messageId) } }).catch((e: unknown) =>
      this.logger.debug({ err: String(e) }, 'baileys: reaction failed'),
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    const key = this.keyFor(messageId);
    if (key.fromMe) await this.send({ delete: key });
  }

  async markRead(messageId: string): Promise<void> {
    const sock = await this.socket();
    await sock.readMessages([this.keyFor(messageId)]).catch(() => undefined);
  }

  async downloadMedia(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string | null }> {
    const m = this.cache.get(ref);
    if (!m) throw new Error('That file is no longer available (the service restarted). Send it again.');
    const sock = await this.socket();
    const data = await downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger: socketLogger(this.logger), reuploadRequest: sock.updateMediaMessage },
    );
    if (data.length > maxBytes) throw new Error('File is larger than MEDIA_MAX_BYTES.');
    return { data, mime: mediaOf(m)?.mime ?? null };
  }

  async sendReopenTemplate(): Promise<boolean> {
    return false;
  }

  windowOpen(): boolean {
    return true;
  }

  /** Serialize for the durable job queue (keeps the media keys, which are binary). */
  static serialize(m: WAMessage): string {
    return JSON.stringify(m, BufferJSON.replacer);
  }

  /** Normalize a stored message. A bare menu number answers the last menu. */
  normalize(payload: string): OwnerMessage | null {
    const m = JSON.parse(payload, BufferJSON.reviver) as WAMessage;
    if (!m.key.id) return null;
    this.remember(m);
    // Newer WhatsApp addresses people by a private "LID"; the phone-number JID comes as the alternate.
    const jid = [m.key.remoteJidAlt, m.key.remoteJid].find((j) => j?.endsWith('@s.whatsapp.net')) ?? m.key.remoteJid;
    const content = normalizeMessageContent(m.message);
    const ctxInfo = content?.extendedTextMessage?.contextInfo;
    const base: OwnerMessage = {
      channel: 'baileys',
      id: m.key.id,
      from: userOf(jid),
      at: Number(m.messageTimestamp ?? 0) * 1000 || Date.now(),
      ...(ctxInfo?.stanzaId ? { replyToId: ctxInfo.stanzaId } : {}),
    };
    const text = content?.conversation ?? content?.extendedTextMessage?.text;
    if (text != null) {
      const pick = this.menuPick(text, base.replyToId);
      if (pick) return { ...base, button: { id: pick } };
      return { ...base, text };
    }
    const media = mediaOf(m);
    if (media) return { ...base, media: { ...media, ref: m.key.id } };
    return { ...base, unsupported: getContentType(content) ?? 'other' };
  }

  private menuPick(text: string, replyToId?: string): string | null {
    const menu = this.menu;
    const n = /^\s*(\d{1,2})\s*$/.exec(text)?.[1];
    if (!menu || !n || Date.now() - menu.at > MENU_TTL) return null;
    if (replyToId && menu.messageId && replyToId !== menu.messageId) return null;
    const id = menu.ids[Number(n) - 1];
    if (id) this.menu = null;
    return id ?? null;
  }
}

function mediaOf(m: WAMessage): { kind: MediaKind; mime?: string; filename?: string; caption?: string } | null {
  const c = normalizeMessageContent(m.message);
  if (!c) return null;
  const pairs: [
    MediaKind,
    { mimetype?: string | null; caption?: string | null; fileName?: string | null } | null | undefined,
  ][] = [
    ['image', c.imageMessage],
    ['document', c.documentMessage ?? c.documentWithCaptionMessage?.message?.documentMessage],
    ['audio', c.audioMessage],
    ['video', c.videoMessage],
    ['sticker', c.stickerMessage],
  ];
  for (const [kind, f] of pairs) {
    if (f)
      return {
        kind,
        ...(f.mimetype ? { mime: f.mimetype.split(';')[0]!.trim() } : {}),
        ...(f.fileName ? { filename: f.fileName } : {}),
        ...(f.caption ? { caption: f.caption } : {}),
      };
  }
  return null;
}
