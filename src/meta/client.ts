import crypto from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import { scrubSecrets } from '../security/redact.js';
import { newId } from '../shared/ids.js';
import { fromGraphError, MetaError, type GraphErrorBody } from './errors.js';

export interface MetaClientOptions {
  /** e.g. https://graph.facebook.com/v24.0 */
  baseUrl: string;
  accessToken: string;
  appSecret: string;
  appsecretProof: boolean;
  logger: Logger;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Tests inject a no-op sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  /** e.g. "/123/messages" */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Retry throttle/transient failures. Never set for message sends. */
  retry?: boolean;
  timeoutMs?: number;
}

/**
 * Thin, safe wrapper over the Graph API: auth, appsecret_proof, timeouts, error mapping,
 * bounded retries for idempotent calls, correlation IDs and secret-free logging.
 */
export class MetaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly proof: string | undefined;

  constructor(private readonly opts: MetaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.proof = opts.appsecretProof
      ? crypto.createHmac('sha256', opts.appSecret).update(opts.accessToken).digest('hex')
      : undefined;
  }

  async request<T>(req: RequestOptions): Promise<T> {
    const maxAttempts = req.retry ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(req);
      } catch (e) {
        if (!(e instanceof MetaError) || !req.retry || !e.retryable || attempt >= maxAttempts) throw e;
        const backoff = e.opts.retryAfterMs ?? Math.round(Math.random() * 500 * 2 ** attempt);
        this.opts.logger.warn({ path: req.path, attempt, backoff, code: e.opts.code }, 'meta: retrying');
        await this.sleep(Math.min(backoff, 30_000));
      }
    }
  }

  private async once<T>(req: RequestOptions): Promise<T> {
    const requestId = newId();
    const url = new URL(this.opts.baseUrl + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (this.proof) url.searchParams.set('appsecret_proof', this.proof);

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${this.opts.accessToken}`,
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      // Network error or timeout: we cannot know whether Meta processed the request.
      const msg = e instanceof Error ? e.message : String(e);
      this.opts.logger.warn({ requestId, path: req.path, err: this.scrub(msg) }, 'meta: no response');
      throw new MetaError('transient', 'No response from Meta (network error or timeout).', { definitive: false });
    }

    this.warnOnUsage(res);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    this.opts.logger.debug(
      {
        requestId,
        method: req.method,
        path: req.path,
        status: res.status,
        ms: Date.now() - started,
        fbTrace: res.headers.get('x-fb-trace-id') ?? undefined,
      },
      'meta: response',
    );

    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const err = fromGraphError(
        (parsed as { error?: GraphErrorBody } | undefined)?.error,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
      // A 5xx after the body was sent: Meta may or may not have acted on it.
      if (res.status >= 500) throw new MetaError(err.cls, err.message, { ...err.opts, definitive: false });
      throw err;
    }
    if (parsed === undefined) {
      throw new MetaError('unknown', 'Meta returned a non-JSON response.', { definitive: false });
    }
    return parsed as T;
  }

  /** Multipart POST (media upload). Never retried: an upload is cheap to redo but not idempotent. */
  async upload<T>(path: string, form: FormData): Promise<T> {
    const url = new URL(this.opts.baseUrl + path);
    if (this.proof) url.searchParams.set('appsecret_proof', this.proof);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MetaError('transient', 'Media upload failed (network error or timeout).', { definitive: false });
    }
    const body = (await res.json().catch(() => undefined)) as { error?: GraphErrorBody } | undefined;
    if (!res.ok) throw fromGraphError(body?.error, res.status);
    if (body === undefined) throw new MetaError('unknown', 'Meta returned a non-JSON response.', { definitive: false });
    return body as T;
  }

  /** Download binary content from a short-lived Meta media URL (requires the bearer token). */
  async download(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.opts.accessToken}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new MetaError('transient', 'Media download failed (network error or timeout).', { definitive: false });
    }
    if (!res.ok) {
      throw new MetaError(res.status >= 500 ? 'transient' : 'invalid_request', `Media download HTTP ${res.status}`, {
        httpStatus: res.status,
        definitive: true,
      });
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new MetaError('invalid_request', 'Media exceeds MEDIA_MAX_BYTES.', { definitive: true });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new MetaError('invalid_request', 'Media exceeds MEDIA_MAX_BYTES.', { definitive: true });
    }
    return { data: buf, contentType: res.headers.get('content-type') };
  }

  private warnOnUsage(res: Response): void {
    for (const h of ['x-business-use-case-usage', 'x-app-usage']) {
      const v = res.headers.get(h);
      if (!v) continue;
      const pcts = [...v.matchAll(/"(?:call_count|total_cputime|total_time)":\s*(\d+)/g)].map((m) => Number(m[1]));
      if (pcts.some((p) => p >= 80)) this.opts.logger.warn({ header: h }, 'meta: API usage above 80%');
    }
  }

  private scrub(text: string): string {
    return scrubSecrets(text, [this.opts.accessToken, this.opts.appSecret]);
  }
}
