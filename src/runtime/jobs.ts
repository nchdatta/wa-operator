import crypto from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { jobs } from '../persistence/schema.js';
import { truncate } from '../security/redact.js';
import { errMsg } from '../shared/errors.js';
import { newId } from '../shared/ids.js';

export type JobKind = (typeof jobs.$inferInsert)['kind'];

const MAX_ATTEMPTS = 5;

/** Durably store inbound work. Returns false for a duplicate (same dedupe key). */
export function storeJob(ctx: AppContext, kind: JobKind, dedupeKey: string, payload: string): boolean {
  const now = ctx.clock.now();
  const res = ctx.db
    .insert(jobs)
    .values({ id: newId(), kind, dedupeKey, payloadJson: payload, createdAt: now, nextAttemptAt: now })
    .onConflictDoNothing()
    .run();
  return res.changes === 1;
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Processes jobs one at a time, oldest first. A failed job is retried with backoff, then parked as
 * `failed`. Handlers must be idempotent (owner messages are deduped by message ID).
 */
export class JobProcessor {
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Record<JobKind, (payload: string) => Promise<void>>,
  ) {}

  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.tick();
  }

  start(pollMs = 5000): void {
    this.timer = setInterval(() => this.wake(), pollMs);
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        for (;;) {
          const now = this.ctx.clock.now();
          const job = this.ctx.db
            .select()
            .from(jobs)
            .where(and(eq(jobs.status, 'queued'), lte(jobs.nextAttemptAt, now)))
            .orderBy(asc(jobs.createdAt))
            .limit(1)
            .get();
          if (!job || this.stopped) break;
          try {
            await this.handlers[job.kind](job.payloadJson);
            this.ctx.db
              .update(jobs)
              .set({ status: 'done', doneAt: now, attempts: job.attempts + 1 })
              .where(eq(jobs.id, job.id))
              .run();
          } catch (e) {
            const attempts = job.attempts + 1;
            const final = attempts >= MAX_ATTEMPTS;
            this.ctx.logger.warn({ job: job.id, attempts, err: errMsg(e) }, 'job failed');
            this.ctx.db
              .update(jobs)
              .set({
                status: final ? 'failed' : 'queued',
                attempts,
                lastError: truncate(errMsg(e), 500),
                nextAttemptAt: now + Math.min(60_000 * 2 ** attempts, 15 * 60_000),
              })
              .where(eq(jobs.id, job.id))
              .run();
          }
        }
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
    }
  }
}
