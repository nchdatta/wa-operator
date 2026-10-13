export type MetaErrorClass = 'auth' | 'throttle' | 'policy' | 'template' | 'transient' | 'invalid_request' | 'unknown';

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string } & Record<string, unknown>;
  fbtrace_id?: string;
}

export interface MetaErrorOptions {
  code?: number | undefined;
  subcode?: number | undefined;
  httpStatus?: number | undefined;
  fbtraceId?: string | undefined;
  details?: string | undefined;
  retryAfterMs?: number | undefined;
  /** True when Meta answered with an error response, so a send was definitely NOT accepted. */
  definitive: boolean;
}

/** A failure talking to Meta. */
export class MetaError extends Error {
  constructor(
    public readonly cls: MetaErrorClass,
    message: string,
    public readonly opts: MetaErrorOptions,
  ) {
    super(message);
    this.name = 'MetaError';
  }

  get retryable(): boolean {
    return this.cls === 'throttle' || this.cls === 'transient';
  }
}

// [VERIFY] codes against https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
const AUTH = new Set([190, 10, 200, 102, 3, 133010, 133000, 141000]);
const THROTTLE = new Set([4, 80007, 130429, 131056, 613]);
const POLICY = new Set([131047, 131049, 131050, 131026, 368, 131031, 131051, 131052, 131053, 131042, 131045, 470]);
const TEMPLATE = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
const TRANSIENT = new Set([1, 2, 131000, 131016, 133004]);

const FRIENDLY: Record<number, string> = {
  190: 'Access token is invalid or expired. Generate a System User token and update WHATSAPP_ACCESS_TOKEN.',
  131047: 'More than 24 hours since the owner last messaged. A template is needed to reopen the chat.',
  131049: 'Meta did not deliver this marketing message (per-user marketing limit).',
  131050: 'The customer has stopped marketing messages from this business.',
  131026: 'Message undeliverable: the number may not be on WhatsApp or cannot receive this message.',
  131056: 'Too many messages to this customer in a short time. Wait before sending again.',
  130429: 'Throughput limit reached. Try again shortly.',
  132001: 'Template does not exist in this language, or is not approved.',
  132000: 'Template parameter count does not match the template.',
  368: 'Account temporarily blocked for policy violations.',
  131031: 'Business account is locked.',
  133010: 'Phone number is not registered on Cloud API.',
};

export function classify(code: number | undefined, httpStatus: number | undefined): MetaErrorClass {
  if (code !== undefined) {
    if (AUTH.has(code)) return 'auth';
    if (THROTTLE.has(code)) return 'throttle';
    if (POLICY.has(code)) return 'policy';
    if (TEMPLATE.has(code)) return 'template';
    if (TRANSIENT.has(code)) return 'transient';
    if (code === 100) return 'invalid_request';
  }
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 429) return 'throttle';
  if (httpStatus !== undefined && httpStatus >= 500) return 'transient';
  if (httpStatus !== undefined && httpStatus >= 400) return 'invalid_request';
  return 'unknown';
}

export function friendlyMessage(code: number | undefined, fallback: string): string {
  return (code !== undefined ? FRIENDLY[code] : undefined) ?? fallback;
}

export function fromGraphError(body: GraphErrorBody | undefined, httpStatus: number, retryAfterMs?: number): MetaError {
  const code = body?.code;
  return new MetaError(
    classify(code, httpStatus),
    friendlyMessage(code, body?.message ?? `Meta API error (HTTP ${httpStatus})`),
    {
      code,
      subcode: body?.error_subcode,
      httpStatus,
      fbtraceId: body?.fbtrace_id,
      details: body?.error_data?.details,
      retryAfterMs,
      definitive: true,
    },
  );
}
