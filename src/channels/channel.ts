/**
 * The owner's chat app, behind one interface. Operator code never calls WhatsApp or Telegram directly,
 * so moving the owner to Telegram (if Meta's AI policy tightens) is one setting: CHANNEL=telegram.
 */

export type ChannelName = 'whatsapp' | 'telegram' | 'baileys';

export interface Button {
  /** ≤ 64 bytes (Telegram callback_data limit; WhatsApp allows 256). */
  id: string;
  /** ≤ 20 characters. */
  title: string;
}

export interface ListRow {
  id: string;
  /** ≤ 24 characters. */
  title: string;
  /** ≤ 72 characters. */
  description?: string;
}

export type MediaKind = 'image' | 'document' | 'audio' | 'video' | 'sticker';

/** One message from the owner, normalized across chat apps. */
export interface OwnerMessage {
  channel: ChannelName;
  /** Provider message ID (wamid, or Telegram message/callback ID). */
  id: string;
  /** Provider sender ID (wa_id or Telegram user ID). */
  from: string;
  at: number;
  /** The message this one replies to, if any. */
  replyToId?: string;
  text?: string;
  button?: { id: string; title?: string };
  /** A PIN submitted through a WhatsApp Flow password field (or a deleted Telegram reply). */
  pin?: { token: string; pin: string };
  media?: { kind: MediaKind; ref: string; mime?: string; filename?: string; caption?: string };
  /** Anything we do not handle (location, contacts, …): its type. */
  unsupported?: string;
}

export interface Channel {
  readonly name: ChannelName;
  /** Longest text message the app accepts. */
  readonly maxText: number;
  sendText(text: string, opts?: { replyTo?: string }): Promise<string | null>;
  /** Up to 3 buttons. */
  sendButtons(body: string, buttons: Button[], opts?: { footer?: string; replyTo?: string }): Promise<string | null>;
  /** Up to 10 rows. */
  sendList(body: string, buttonText: string, rows: ListRow[]): Promise<string | null>;
  sendFile(
    filePath: string,
    opts: { kind: 'document' | 'image'; caption?: string; filename?: string },
  ): Promise<string | null>;
  /**
   * Ask for the PIN without it ever sitting in the chat as text: a WhatsApp Flow password field,
   * or on Telegram a prompt whose reply is deleted the moment it arrives.
   */
  requestPin(token: string, prompt: string): Promise<void>;
  react(messageId: string, emoji: string): Promise<void>;
  downloadMedia(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string | null }>;
  /** WhatsApp only: a utility template asking the owner to reply, when the 24-hour window is closed. */
  sendReopenTemplate(): Promise<boolean>;
  /** Whether free-form messages can be sent right now (WhatsApp 24-hour window). */
  windowOpen(lastOwnerMessageAt: number | null, now: number): boolean;
  deleteMessage?(messageId: string): Promise<void>;
  /** Text-reply PIN mode: if this message answers an open PIN prompt, return its token (and consume it). */
  takeTextPin?(text: string, replyToId?: string): string | null;
  /** Text-reply PIN mode: remove the answered prompt and as much of the PIN reply as the channel allows. */
  wipePin?(pinMessageId: string): Promise<void>;
}
