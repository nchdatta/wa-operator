import crypto from 'node:crypto';

/**
 * Verify Meta's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256 of the exact raw body
 * with the app secret, compared in constant time.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length).trim();
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given.toLowerCase(), 'hex'));
}

export function sign(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
