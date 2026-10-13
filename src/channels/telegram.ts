import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.js';
import type { Logger } from '../observability/logger.js';
import { scrubSecrets, truncate } from '../security/redact.js';
import { MINUTE } from '../shared/clock.js';
import type { Button, Channel, ListRow, MediaKind, OwnerMessage } from './channel.js';
import { mimeFor } from './mime.js';

/**
 * Telegram Bot API fallback. Same buttons, files and voice as WhatsApp, and no AI ban.
 * The PIN prompt asks for a reply, and the reply is deleted the moment it arrives.
 */

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number };
  };
}

interface TgFileRef {
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

interface TgMessage {
  message_id: number;
  date: number;
  from?: { id: number };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  photo?: TgFileRef[];
  document?: TgFileRef;
  voice?: TgFileRef;
  audio?: TgFileRef;
  video?: TgFileRef;
  sticker?: TgFileRef;
}

const PIN_PROMPT_TTL = 5 * MINUTE;

export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const;
  readonly maxText = 4096;
  /** PIN prompt message ID → one-time token. In memory: after a restart the owner is simply asked again. */
  private readonly pinPrompts = new Map<number, { token: string; at: number }>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    opts: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get chatId(): string {
    return this.config.TELEGRAM_OPERATOR_USER_ID!;
  }

  async call<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<T> {
    const url = `${this.config.TELEGRAM_API_BASE_URL}/bot${this.config.TELEGRAM_BOT_TOKEN}/${method}`;
    const isForm = body instanceof FormData;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`Telegram ${method}: ${this.scrub(e instanceof Error ? e.message : String(e))}`, { cause: e });
    }
    const parsed = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse<T>;
    if (!parsed.ok) throw new Error(`Telegram ${method}: ${this.scrub(parsed.description ?? 'error')}`);
    return parsed.result as T;
  }

  private scrub(s: string): string {
    return scrubSecrets(s, [this.config.TELEGRAM_BOT_TOKEN ?? '']);
  }

  async sendText(text: string, opts: { replyTo?: string } = {}): Promise<string | null> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text,
      ...(opts.replyTo
        ? { reply_parameters: { message_id: Number(opts.replyTo), allow_sending_without_reply: true } }
        : {}),
    });
    return String(r.message_id);
  }

  async sendButtons(
    body: string,
    buttons: Button[],
    opts: { footer?: string; replyTo?: string } = {},
  ): Promise<string | null> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text: opts.footer ? `${body}\n\n${opts.footer}` : body,
      reply_markup: { inline_keyboard: [buttons.slice(0, 3).map((b) => ({ text: b.title, callback_data: b.id }))] },
    });
    return String(r.message_id);
  }

  async sendList(body: string, _buttonText: string, rows: ListRow[]): Promise<string | null> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text: body,
      reply_markup: {
        inline_keyboard: rows.slice(0, 10).map((row) => [{ text: truncate(row.title, 60), callback_data: row.id }]),
      },
    });
    return String(r.message_id);
  }

  async sendFile(
    filePath: string,
    opts: { kind: 'document' | 'image'; caption?: string; filename?: string },
  ): Promise<string | null> {
    const data = await fs.promises.readFile(filePath);
    const filename = opts.filename ?? path.basename(filePath);
    const photo = opts.kind === 'image' && /^image\//.test(mimeFor(filename));
    const form = new FormData();
    form.set('chat_id', this.chatId);
    if (opts.caption) form.set('caption', truncate(opts.caption, 1024));
    form.set(photo ? 'photo' : 'document', new Blob([new Uint8Array(data)], { type: mimeFor(filename) }), filename);
    const r = await this.call<{ message_id: number }>(photo ? 'sendPhoto' : 'sendDocument', form, 120_000);
    return String(r.message_id);
  }

  async requestPin(token: string, prompt: string): Promise<void> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text: `${prompt}\n\nReply with your PIN. It is deleted the moment it arrives.`,
      reply_markup: { force_reply: true, input_field_placeholder: 'PIN' },
    });
    this.pinPrompts.set(r.message_id, { token, at: Date.now() });
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await this.call('setMessageReaction', {
      chat_id: this.chatId,
      message_id: Number(messageId),
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }).catch((e: unknown) => this.logger.debug({ err: String(e) }, 'telegram: reaction failed'));
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.call('deleteMessage', { chat_id: this.chatId, message_id: Number(messageId) });
  }

  async downloadMedia(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string | null }> {
    const f = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: ref });
    if (!f.file_path)
      throw new Error('Telegram returned no file path (files over 20 MB cannot be downloaded by bots).');
    if (f.file_size && f.file_size > maxBytes) throw new Error('File is larger than MEDIA_MAX_BYTES.');
    const res = await this.fetchImpl(
      `${this.config.TELEGRAM_API_BASE_URL}/file/bot${this.config.TELEGRAM_BOT_TOKEN}/${f.file_path}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) throw new Error('File is larger than MEDIA_MAX_BYTES.');
    return { data, mime: res.headers.get('content-type') };
  }

  async sendReopenTemplate(): Promise<boolean> {
    return false;
  }

  windowOpen(): boolean {
    return true;
  }

  /**
   * Normalize an update. A reply to a PIN prompt (or a bare 4–12 digit message while one is open)
   * becomes a PIN submission and is deleted from the chat right away.
   */
  async normalize(u: TgUpdate): Promise<OwnerMessage | null> {
    if (u.callback_query) {
      const q = u.callback_query;
      await this.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
      return {
        channel: 'telegram',
        id: `cb:${q.id}`,
        from: String(q.from.id),
        at: Date.now(),
        button: { id: q.data ?? '' },
        ...(q.message ? { replyToId: String(q.message.message_id) } : {}),
      };
    }
    const m = u.message;
    if (!m || m.chat.type !== 'private' || !m.from) return null;
    const base: OwnerMessage = {
      channel: 'telegram',
      id: String(m.message_id),
      from: String(m.from.id),
      at: m.date * 1000,
      ...(m.reply_to_message ? { replyToId: String(m.reply_to_message.message_id) } : {}),
    };
    if (m.text !== undefined) {
      const pin = this.matchPin(m);
      if (pin) {
        await this.deleteMessage(String(m.message_id)).catch((e: unknown) =>
          this.logger.warn({ err: String(e) }, 'telegram: could not delete PIN message; delete it by hand'),
        );
        return { ...base, pin: { token: pin, pin: m.text.trim() } };
      }
      return { ...base, text: m.text };
    }
    const media = pickMedia(m);
    if (media) return { ...base, media: { ...media, ...(m.caption ? { caption: m.caption } : {}) } };
    return { ...base, unsupported: 'other' };
  }

  private matchPin(m: TgMessage): string | null {
    const now = Date.now();
    for (const [id, p] of this.pinPrompts) if (now - p.at > PIN_PROMPT_TTL) this.pinPrompts.delete(id);
    const replied = m.reply_to_message ? this.pinPrompts.get(m.reply_to_message.message_id) : undefined;
    const open = replied ?? (/^\s*\d{4,12}\s*$/.test(m.text ?? '') ? [...this.pinPrompts.values()].at(-1) : undefined);
    if (!open) return null;
    for (const [id, p] of this.pinPrompts) if (p.token === open.token) this.pinPrompts.delete(id);
    return open.token;
  }
}

function pickMedia(m: TgMessage): { kind: MediaKind; ref: string; mime?: string; filename?: string } | null {
  const largestPhoto = m.photo?.at(-1);
  const pairs: [MediaKind, TgFileRef | undefined][] = [
    ['image', largestPhoto],
    ['document', m.document],
    ['audio', m.voice ?? m.audio],
    ['video', m.video],
    ['sticker', m.sticker],
  ];
  for (const [kind, f] of pairs) {
    if (f)
      return {
        kind,
        ref: f.file_id,
        ...(f.mime_type ? { mime: f.mime_type } : kind === 'image' ? { mime: 'image/jpeg' } : {}),
        ...(f.file_name ? { filename: f.file_name } : {}),
      };
  }
  return null;
}

/** Long-polls getUpdates and hands each update to `store` (durable) before advancing the offset. */
export class TelegramPoller {
  private stopped = false;
  private offset = 0;

  constructor(
    private readonly channel: TelegramChannel,
    private readonly logger: Logger,
    private readonly store: (u: TgUpdate) => void,
  ) {}

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.channel.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          45_000,
        );
        for (const u of updates) {
          this.store(u);
          this.offset = u.update_id + 1;
        }
      } catch (e) {
        if (this.stopped) break;
        this.logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'telegram: poll failed, retrying');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
