import { eq, isNull } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { deferredMessages, operatorState } from '../persistence/schema.js';
import { scrubSecrets } from '../security/redact.js';
import { errMsg } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { chunkText, toChatFormat } from '../shared/text.js';
import type { Button, Channel, ListRow } from './channel.js';

/**
 * The single place that talks to the owner. Adds what every message needs: secret scrubbing,
 * chunking under the app's limit, and the WhatsApp 24-hour window (text is held and a template sent
 * when it is closed; the held text goes out as soon as the owner writes again).
 */
export class OwnerChat {
  private templateSentAt = 0;

  constructor(
    private readonly ctx: AppContext,
    readonly channel: Channel,
  ) {}

  private lastOwnerAt(): number | null {
    return this.ctx.db.select().from(operatorState).where(eq(operatorState.id, 1)).get()?.lastOwnerMessageAt ?? null;
  }

  private open(): boolean {
    return this.channel.windowOpen(this.lastOwnerAt(), this.ctx.clock.now());
  }

  private clean(text: string): string {
    return scrubSecrets(text, this.ctx.secrets);
  }

  /** Send text (any length). Returns the ID of the last message sent, or null if held for later. */
  async say(text: string, opts: { replyTo?: string; format?: boolean } = {}): Promise<string | null> {
    const body = this.clean(opts.format === false ? text : toChatFormat(text));
    if (!body.trim()) return null;
    if (!this.open()) {
      await this.hold(body);
      return null;
    }
    let last: string | null = null;
    for (const [i, part] of chunkText(body, this.channel.maxText).entries()) {
      last = await this.channel.sendText(part, i === 0 && opts.replyTo ? { replyTo: opts.replyTo } : {});
    }
    return last;
  }

  /** Best-effort send that never throws (notices, errors). */
  async notify(text: string, opts: { replyTo?: string } = {}): Promise<void> {
    try {
      await this.say(text, opts);
    } catch (e) {
      this.ctx.logger.warn({ err: errMsg(e) }, 'owner notice failed');
    }
  }

  async buttons(body: string, buttons: Button[], opts: { footer?: string; replyTo?: string } = {}) {
    if (!this.open()) {
      await this.hold(`${body}\n(Open the chat and ask again to get the buttons.)`);
      return null;
    }
    return this.channel.sendButtons(this.clean(body), buttons, opts);
  }

  async list(body: string, buttonText: string, rows: ListRow[]) {
    if (!this.open()) return null;
    return this.channel.sendList(this.clean(body), buttonText, rows);
  }

  async file(filePath: string, opts: { kind: 'document' | 'image'; caption?: string; filename?: string }) {
    if (!this.open()) {
      await this.hold(`📎 A file is ready: ${opts.filename ?? filePath}. Reply to get it.`);
      return null;
    }
    return this.channel.sendFile(filePath, opts.caption ? { ...opts, caption: this.clean(opts.caption) } : opts);
  }

  async requestPin(token: string, prompt: string): Promise<void> {
    await this.channel.requestPin(token, prompt);
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await this.channel
      .react(messageId, emoji)
      .catch((e: unknown) => this.ctx.logger.debug({ err: errMsg(e) }, 'reaction failed'));
  }

  private async hold(text: string): Promise<void> {
    const now = this.ctx.clock.now();
    this.ctx.db.insert(deferredMessages).values({ id: newId(), text, createdAt: now }).run();
    if (now - this.templateSentAt < 6 * 3600_000) return;
    try {
      if (await this.channel.sendReopenTemplate()) {
        this.templateSentAt = now;
        audit(this.ctx, { actor: 'system', action: 'window.template_sent', outcome: 'ok' });
      } else {
        this.ctx.logger.warn('24-hour window closed and OPERATOR_REPLY_TEMPLATE is not set; message held');
      }
    } catch (e) {
      this.ctx.logger.warn({ err: errMsg(e) }, 'reopen template failed');
    }
  }

  /** The owner just wrote: the window is open again, so send whatever was held. */
  async flushHeld(): Promise<void> {
    const rows = this.ctx.db.select().from(deferredMessages).where(isNull(deferredMessages.sentAt)).all();
    for (const r of rows) {
      try {
        await this.say(`(held while the chat was closed)\n${r.text}`, { format: false });
        this.ctx.db
          .update(deferredMessages)
          .set({ sentAt: this.ctx.clock.now() })
          .where(eq(deferredMessages.id, r.id))
          .run();
      } catch (e) {
        this.ctx.logger.warn({ err: errMsg(e) }, 'could not send held message');
        return;
      }
    }
  }
}
