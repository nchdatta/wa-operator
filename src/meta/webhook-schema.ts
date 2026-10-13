import { z } from 'zod';

// Webhook payload schemas. Deliberately permissive (looseObject) so new Meta fields never break ingestion;
// only the fields we rely on are typed.

const tsString = z.union([z.string(), z.number()]).transform((v) => Number(v) * 1000);

const MediaObj = z.looseObject({
  id: z.string(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

export const InboundMessage = z.looseObject({
  from: z.string().optional(),
  id: z.string(),
  timestamp: tsString,
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: MediaObj.optional(),
  video: MediaObj.optional(),
  audio: MediaObj.optional(),
  document: MediaObj.optional(),
  sticker: MediaObj.optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      nfm_reply: z.looseObject({ response_json: z.string().optional(), name: z.string().optional() }).optional(),
    })
    .optional(),
  button: z.looseObject({ payload: z.string().optional(), text: z.string().optional() }).optional(),
  context: z.looseObject({ from: z.string().optional(), id: z.string().optional() }).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export const MessagesValue = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

export const WebhookPayload = z.looseObject({
  object: z.string(),
  entry: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).default([]),
      }),
    )
    .min(1),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
