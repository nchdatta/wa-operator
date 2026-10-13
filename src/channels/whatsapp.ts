import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.js';
import type { MetaClient } from '../meta/client.js';
import { getMediaInfo, markRead, sendMessage, uploadMedia } from '../meta/messages.js';
import { InboundMessage, MessagesValue, type WebhookPayload } from '../meta/webhook-schema.js';
import type { Logger } from '../observability/logger.js';
import { truncate } from '../security/redact.js';
import { HOUR } from '../shared/clock.js';
import { errMsg } from '../shared/errors.js';
import type { Button, Channel, ListRow, MediaKind, OwnerMessage } from './channel.js';
import { mimeFor } from './mime.js';

const WINDOW_MS = 24 * HOUR;
/** Leave a margin so a message sent at 23:59:59 is not rejected in flight. */
const WINDOW_MARGIN_MS = 5 * 60_000;

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp' as const;
  readonly maxText = 4096;

  constructor(
    private readonly client: MetaClient,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private get to(): string {
    return this.config.OPERATOR_WA_ID!;
  }

  private send(message: Record<string, unknown>, replyTo?: string): Promise<string> {
    return sendMessage(this.client, this.config.WHATSAPP_PHONE_NUMBER_ID!, this.to, message, replyTo);
  }

  async sendText(text: string, opts: { replyTo?: string } = {}): Promise<string | null> {
    return this.send({ type: 'text', text: { body: text, preview_url: false } }, opts.replyTo);
  }

  async sendButtons(
    body: string,
    buttons: Button[],
    opts: { footer?: string; replyTo?: string } = {},
  ): Promise<string | null> {
    return this.send(
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: truncate(body, 1024) },
          ...(opts.footer ? { footer: { text: truncate(opts.footer, 60) } } : {}),
          action: {
            buttons: buttons
              .slice(0, 3)
              .map((b) => ({ type: 'reply', reply: { id: b.id, title: truncate(b.title, 20) } })),
          },
        },
      },
      opts.replyTo,
    );
  }

  async sendList(body: string, buttonText: string, rows: ListRow[]): Promise<string | null> {
    return this.send({
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: truncate(body, 4096) },
        action: {
          button: truncate(buttonText, 20),
          sections: [
            {
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: truncate(r.title, 24),
                ...(r.description ? { description: truncate(r.description, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  async sendFile(
    filePath: string,
    opts: { kind: 'document' | 'image'; caption?: string; filename?: string },
  ): Promise<string | null> {
    const data = await fs.promises.readFile(filePath);
    const filename = opts.filename ?? path.basename(filePath);
    const mime = mimeFor(filename);
    const kind = opts.kind === 'image' && /^image\/(png|jpeg)$/.test(mime) ? 'image' : 'document';
    const mediaId = await uploadMedia(this.client, this.config.WHATSAPP_PHONE_NUMBER_ID!, data, mime, filename);
    const caption = opts.caption ? { caption: truncate(opts.caption, 1024) } : {};
    return this.send(
      kind === 'image'
        ? { type: 'image', image: { id: mediaId, ...caption } }
        : { type: 'document', document: { id: mediaId, filename, ...caption } },
    );
  }

  /** Text-reply PIN mode (used while Meta blocks Flows for an unverified business). */
  private flowBlocked = false;
  private textPin: { token: string; at: number; promptId: string | null } | null = null;

  takeTextPin(text: string, replyToId?: string): string | null {
    const p = this.textPin;
    if (!p || Date.now() - p.at > 10 * 60_000) return null;
    const isReply = !!replyToId && replyToId === p.promptId;
    if (!isReply && !/^\s*\d{4,12}\s*$/.test(text)) return null;
    this.textPin = null;
    return p.token;
  }

  async requestPin(token: string, prompt: string): Promise<void> {
    const flowId = this.config.OPERATOR_PIN_FLOW_ID;
    if (this.config.OPERATOR_PIN_FLOW_MODE === 'text' || !flowId || this.flowBlocked) {
      const id = await this.sendText(`${prompt}\n\nReply with your PIN, then long-press your message → Delete for me.`);
      this.textPin = { token, at: Date.now(), promptId: id };
      return;
    }
    try {
      await this.send({
        type: 'interactive',
        interactive: {
          type: 'flow',
          body: { text: truncate(prompt, 1024) },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_token: token,
              flow_id: flowId,
              flow_cta: 'Enter PIN',
              flow_action: 'navigate',
              flow_action_payload: { screen: 'PIN' },
              ...(this.config.OPERATOR_PIN_FLOW_MODE === 'draft' ? { mode: 'draft' } : {}),
            },
          },
        },
      });
    } catch (e) {
      // Meta blocks Flows (even drafts) for an unverified business: fall back to a text PIN until restart.
      if (!/139000|Integrity/i.test(errMsg(e))) throw e;
      this.flowBlocked = true;
      return this.requestPin(token, prompt);
    }
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await this.send({ type: 'reaction', reaction: { message_id: messageId, emoji } });
  }

  async downloadMedia(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string | null }> {
    const info = await getMediaInfo(this.client, ref, this.config.WHATSAPP_PHONE_NUMBER_ID!);
    const { data, contentType } = await this.client.download(info.url, maxBytes);
    return { data, mime: info.mime_type ?? contentType };
  }

  async sendReopenTemplate(): Promise<boolean> {
    const name = this.config.OPERATOR_REPLY_TEMPLATE;
    if (!name) return false;
    await this.send({
      type: 'template',
      template: { name, language: { code: this.config.OPERATOR_REPLY_TEMPLATE_LANG } },
    });
    return true;
  }

  windowOpen(lastOwnerMessageAt: number | null, now: number): boolean {
    return lastOwnerMessageAt !== null && now - lastOwnerMessageAt < WINDOW_MS - WINDOW_MARGIN_MS;
  }

  /** Blue ticks on the owner's message; failures are only logged. */
  async markRead(wamid: string): Promise<void> {
    await markRead(this.client, this.config.WHATSAPP_PHONE_NUMBER_ID!, wamid).catch((e: unknown) =>
      this.logger.debug({ err: e instanceof Error ? e.message : String(e) }, 'whatsapp: mark read failed'),
    );
  }
}

/** Extract normalized messages for our phone number from a verified webhook payload. Status updates are ignored. */
export function parseWhatsAppWebhook(payload: WebhookPayload, phoneNumberId: string): OwnerMessage[] {
  const out: OwnerMessage[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = MessagesValue.safeParse(change.value);
      if (!value.success || value.data.metadata.phone_number_id !== phoneNumberId) continue;
      for (const rawMsg of value.data.messages ?? []) {
        const m = InboundMessage.safeParse(rawMsg);
        if (m.success && m.data.from) out.push(normalize(m.data, m.data.from));
      }
    }
  }
  return out;
}

function normalize(m: InboundMessage, from: string): OwnerMessage {
  const base: OwnerMessage = {
    channel: 'whatsapp',
    id: m.id,
    from,
    at: m.timestamp,
    ...(m.context?.id ? { replyToId: m.context.id } : {}),
  };
  switch (m.type) {
    case 'text':
      return { ...base, text: m.text?.body ?? '' };
    case 'interactive': {
      const i = m.interactive;
      const reply = i?.button_reply ?? i?.list_reply;
      if (reply) return { ...base, button: { id: reply.id, title: reply.title } };
      if (i?.nfm_reply?.response_json) {
        const pin = parseFlowPin(i.nfm_reply.response_json);
        if (pin) return { ...base, pin };
      }
      return { ...base, unsupported: `interactive:${i?.type ?? 'unknown'}` };
    }
    case 'button':
      return { ...base, button: { id: m.button?.payload ?? '', title: m.button?.text ?? '' } };
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      const media = m[m.type];
      if (!media) return { ...base, unsupported: m.type };
      return {
        ...base,
        media: {
          kind: m.type as MediaKind,
          ref: media.id,
          ...(media.mime_type ? { mime: media.mime_type } : {}),
          ...(media.filename ? { filename: media.filename } : {}),
          ...(media.caption ? { caption: media.caption } : {}),
        },
      };
    }
    default:
      return { ...base, unsupported: m.type };
  }
}

/** The PIN Flow completes with `{ "flow_token": "...", "pin": "..." }` (see config/flows/pin-flow.json). */
export function parseFlowPin(responseJson: string): { token: string; pin: string } | null {
  try {
    const r = JSON.parse(responseJson) as { flow_token?: unknown; pin?: unknown };
    if (typeof r.flow_token === 'string' && typeof r.pin === 'string') return { token: r.flow_token, pin: r.pin };
  } catch {
    // fall through
  }
  return null;
}
