/** Paths pino must never print. Values are replaced with "[REDACTED]". */
export const REDACT_PATHS = [
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  '*.headers.authorization',
  'access_token',
  '*.access_token',
  'appsecret_proof',
  '*.appsecret_proof',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'WHATSAPP_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  '*.WHATSAPP_ACCESS_TOKEN',
  '*.META_APP_SECRET',
  '*.META_VERIFY_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '*.CLAUDE_CODE_OAUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  '*.TELEGRAM_BOT_TOKEN',
  'pin',
  '*.pin',
];

/** Mask a phone-like WhatsApp ID for logs: 8801712345621 -> 8801*******21. */
export function maskWaId(waId: string | null | undefined): string {
  if (!waId) return '';
  if (waId.length <= 6) return '*'.repeat(waId.length);
  return `${waId.slice(0, 4)}${'*'.repeat(waId.length - 6)}${waId.slice(-2)}`;
}

/** Remove any of the given secret strings from free text (e.g. an upstream error message). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
