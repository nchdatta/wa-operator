import { z } from 'zod';
import type { MetaClient } from './client.js';
import { MetaError } from './errors.js';

const SendResponse = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
});

/**
 * POST /{phone-number-id}/messages exactly once. Never retried: Meta has no idempotency key, and a
 * duplicate approval card or answer is worse than a reported failure.
 */
export async function sendMessage(
  client: MetaClient,
  phoneNumberId: string,
  to: string,
  message: Record<string, unknown>,
  replyTo?: string,
): Promise<string> {
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...(replyTo && message.type !== 'reaction' ? { context: { message_id: replyTo } } : {}),
    ...message,
  };
  const raw = await client.request<unknown>({ method: 'POST', path: `/${phoneNumberId}/messages`, body, retry: false });
  const parsed = SendResponse.safeParse(raw);
  if (!parsed.success) {
    throw new MetaError('unknown', 'Meta accepted the request but returned no message id.', { definitive: false });
  }
  return parsed.data.messages[0]!.id;
}

/** Upload a local file for sending; returns the media ID. */
export async function uploadMedia(
  client: MetaClient,
  phoneNumberId: string,
  data: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', mime);
  form.set('file', new Blob([new Uint8Array(data)], { type: mime }), filename);
  const res = await client.upload<{ id?: string }>(`/${phoneNumberId}/media`, form);
  if (!res.id) throw new MetaError('unknown', 'Meta returned no media id.', { definitive: false });
  return res.id;
}

const MediaInfo = z.looseObject({ url: z.url(), mime_type: z.string().optional() });

export async function getMediaInfo(client: MetaClient, mediaId: string, phoneNumberId: string) {
  const raw = await client.request<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(mediaId)}`,
    query: { phone_number_id: phoneNumberId },
    retry: true,
  });
  return MediaInfo.parse(raw);
}

/** Mark the owner's message read (blue ticks), best effort. */
export async function markRead(client: MetaClient, phoneNumberId: string, wamid: string): Promise<void> {
  await client.request({
    method: 'POST',
    path: `/${phoneNumberId}/messages`,
    body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
    retry: true,
  });
}
