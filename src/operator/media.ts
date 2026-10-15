import fs from 'node:fs';
import path from 'node:path';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { OwnerMessage } from '../channels/channel.js';
import { extFor } from '../channels/mime.js';
import type { AppContext } from '../context.js';
import { dayKey } from './gate.js';

/**
 * Photos and PDFs from the owner land in the inbox folder, where Claude can read them.
 * Claude cannot hear audio: voice notes are transcribed by an optional local whisper.cpp server,
 * otherwise the owner is pointed to the phone keyboard's voice typing.
 */

function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from file names
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120);
}

/** HHmm in the business time zone. */
function clockKey(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}${get('minute')}`;
}

export async function saveToInbox(
  ctx: AppContext,
  chat: OwnerChat,
  media: NonNullable<OwnerMessage['media']>,
): Promise<string> {
  const { data, mime } = await chat.channel.downloadMedia(media.ref, ctx.config.MEDIA_MAX_BYTES);
  const now = ctx.clock.now();
  const day = dayKey(now, ctx.config.BUSINESS_TIMEZONE);
  const dir = path.join(ctx.config.inbox, day.slice(0, 7));
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = media.filename ? path.extname(media.filename) || extFor(mime ?? media.mime) : extFor(mime ?? media.mime);
  // "2026-10-14 1649 - Voice.ogg" or "2026-10-14 1649 - <their file name>.pdf": sorts by time, still readable.
  const label = media.filename
    ? path.basename(media.filename, path.extname(media.filename))
    : media.kind.charAt(0).toUpperCase() + media.kind.slice(1);
  const stem = `${day} ${clockKey(now, ctx.config.BUSINESS_TIMEZONE)} - ${label}`;
  let file = path.join(dir, safeName(`${stem}${ext}`));
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, safeName(`${stem}-${i}${ext}`));
  await fs.promises.writeFile(file, data);
  return file;
}

/**
 * whisper on "auto" sometimes guesses the wrong language and returns a mix of scripts (Korean, Kannada…).
 * The owner speaks Bangla or English, so letters from any other script mean the note was not understood.
 */
export function looksGarbled(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 2) return true;
  const foreign = letters.filter((c) => !/[A-Za-zÀ-ɏঀ-৿]/.test(c)).length;
  return foreign > 0;
}

/** POST the audio to whisper.cpp's /inference endpoint (start the server with --convert for OGG/Opus). */
export async function transcribe(
  whisperUrl: string,
  file: string,
  fetchImpl: typeof fetch = fetch,
  language = 'auto',
): Promise<string> {
  const form = new FormData();
  const data = await fs.promises.readFile(file);
  form.set('file', new Blob([new Uint8Array(data)]), path.basename(file));
  form.set('response_format', 'json');
  form.set('language', language);
  const res = await fetchImpl(`${whisperUrl.replace(/\/$/, '')}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`whisper.cpp HTTP ${res.status}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? '').trim();
}
