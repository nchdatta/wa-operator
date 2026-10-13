import crypto from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { AppContext } from '../context.js';
import { WebhookPayload } from '../meta/webhook-schema.js';
import { sha256, storeJob } from '../runtime/jobs.js';
import { verifySignature } from './signature.js';

export interface WebhookAppOptions {
  /** Called after an event is durably stored (wakes the processor). */
  onStored?: () => void;
  /** Health details for the external watcher. */
  ready?: () => { ok: boolean; checks: Record<string, unknown> };
}

const MAX_BODY = '3mb';

/**
 * Meta webhook: verify the signature on the raw body, store it durably, answer 200 straight away.
 * All real work happens in the job processor, so the acknowledgement stays well under 50 ms.
 */
export function createWebhookApp(ctx: AppContext, opts: WebhookAppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const path = ctx.config.WEBHOOK_PATH;
  const verifyToken = ctx.config.META_VERIFY_TOKEN ?? '';
  const appSecret = ctx.config.META_APP_SECRET ?? '';

  app.get(path, (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (
      verifyToken &&
      mode === 'subscribe' &&
      typeof token === 'string' &&
      typeof challenge === 'string' &&
      challenge.length <= 256 &&
      safeEqual(token, verifyToken)
    ) {
      ctx.logger.info('webhook: subscription verified');
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    ctx.logger.warn('webhook: subscription verification rejected');
    res.sendStatus(403);
  });

  app.post(path, express.raw({ type: () => true, limit: MAX_BODY }), (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!appSecret || !verifySignature(raw, req.get('x-hub-signature-256'), appSecret)) {
      ctx.logger.warn({ bytes: raw.length }, 'webhook: invalid signature');
      res.sendStatus(401);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      res.sendStatus(400);
      return;
    }
    if (!WebhookPayload.safeParse(parsed).success) {
      res.sendStatus(400);
      return;
    }
    try {
      if (storeJob(ctx, 'whatsapp_webhook', `wa:${sha256(raw)}`, raw.toString('utf8'))) opts.onStored?.();
    } catch (e) {
      // Not persisted: 500 so Meta retries delivery.
      ctx.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'webhook: failed to persist event');
      res.sendStatus(500);
      return;
    }
    res.sendStatus(200);
  });

  app.get('/health/live', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/health/ready', (_req, res) => {
    const r = opts.ready?.() ?? { ok: true, checks: {} };
    res.status(r.ok ? 200 : 503).json(r);
  });

  app.use((_req, res) => {
    res.sendStatus(404);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.sendStatus(413);
      return;
    }
    ctx.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'webhook: unhandled error');
    res.sendStatus(status && status >= 400 && status < 500 ? status : 500);
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
