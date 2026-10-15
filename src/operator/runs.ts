import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { AppContext } from '../context.js';
import { operatorRuns } from '../persistence/schema.js';
import type { Governor } from '../runtime/governor.js';
import { truncate } from '../security/redact.js';
import { errMsg } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import type { Gate } from './gate.js';
import type { SessionPool } from './pool.js';
import type { RunResult } from './session.js';

/**
 * Owner instructions as durable runs. Up to one per session slot run at once; the rest wait as `queued`.
 * After a restart, a run that was in progress is reported back instead of silently lost.
 */
export class RunQueue {
  private draining = false;
  /** Runs claimed and handed to the pool (counted before the slot reports busy). */
  private active = 0;
  /** Follow-ups that should continue in the slot that answered the replied-to message. */
  private readonly preferSlot = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly chat: OwnerChat,
    private readonly gate: Gate,
    private readonly pool: SessionPool,
    private readonly governor: Governor,
  ) {}

  queuedCount(): number {
    return this.ctx.db.select({ n: count() }).from(operatorRuns).where(eq(operatorRuns.status, 'queued')).get()?.n ?? 0;
  }

  private queued() {
    return this.ctx.db
      .select()
      .from(operatorRuns)
      .where(eq(operatorRuns.status, 'queued'))
      .orderBy(asc(operatorRuns.createdAt))
      .all();
  }

  async enqueue(
    prompt: string,
    sourceMessageId: string | null,
    origin: 'owner' | 'schedule' = 'owner',
    preferSlot?: number,
  ): Promise<string> {
    const id = newId();
    if (preferSlot !== undefined) this.preferSlot.set(id, preferSlot);
    const waiting = this.active >= this.pool.size || this.queuedCount() > 0;
    this.ctx.db
      .insert(operatorRuns)
      .values({ id, status: 'queued', origin, prompt, sourceMessageId, createdAt: this.ctx.clock.now() })
      .run();
    if (waiting && origin === 'owner' && this.gate.isUnlocked()) {
      const n = this.queuedCount();
      if (sourceMessageId) await this.chat.react(sourceMessageId, '📥');
      await this.chat.notify(
        `Got it. I'll start this after the current job (#${this.pool.runningCount() + n}). Say "cancel ${this.pool.runningCount() + n}" to drop it.`,
        sourceMessageId ? { replyTo: sourceMessageId } : {},
      );
    }
    void this.drain();
    return id;
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < this.pool.size) {
        // While locked only scheduled runs go ahead (read-only, see the session gate); the owner's wait.
        const unlocked = this.gate.isUnlocked();
        if (!unlocked && !this.gate.state().enabled) break;
        const next = this.ctx.db
          .select()
          .from(operatorRuns)
          .where(
            unlocked
              ? eq(operatorRuns.status, 'queued')
              : and(eq(operatorRuns.status, 'queued'), eq(operatorRuns.origin, 'schedule')),
          )
          .orderBy(asc(operatorRuns.createdAt))
          .limit(1)
          .get();
        if (!next) break;
        if (!this.claim(next.id)) continue;
        this.active++;
        void this.execute(next).finally(() => {
          this.active--;
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private claim(id: string): boolean {
    return (
      this.ctx.db
        .update(operatorRuns)
        .set({ status: 'running', startedAt: this.ctx.clock.now() })
        .where(and(eq(operatorRuns.id, id), eq(operatorRuns.status, 'queued')))
        .run().changes === 1
    );
  }

  private async execute(run: typeof operatorRuns.$inferSelect): Promise<void> {
    if (!this.governor.canRunOwnerTask()) {
      this.finish(run.id, 'failed', { error: 'usage limit' });
      await this.chat.notify(`Claude usage limit reached (${this.governor.describe()}). Try again later.`);
      return;
    }
    let result: RunResult;
    try {
      // Start the task before any await, so the slot is taken in this tick.
      const pending = this.pool.runTask({
        id: run.id,
        prompt: run.prompt,
        sourceMessageId: run.sourceMessageId,
        origin: run.origin,
        ...(this.preferSlot.has(run.id) ? { preferSlot: this.preferSlot.get(run.id)! } : {}),
      });
      if (run.sourceMessageId) await this.chat.react(run.sourceMessageId, '⏳');
      result = await pending;
    } catch (e) {
      result = {
        ok: false,
        text: `Could not start the task: ${truncate(errMsg(e), 300)}`,
        stopped: false,
        toolCalls: 0,
        tainted: false,
      };
    }
    const status = result.stopped ? 'stopped' : result.ok ? 'done' : 'failed';
    this.finish(run.id, status, { result: result.text, toolCalls: result.toolCalls, tainted: result.tainted });
    audit(this.ctx, {
      actor: 'claude',
      action: 'run.finished',
      target: run.id,
      outcome: status,
      metadata: { toolCalls: result.toolCalls, tainted: result.tainted },
    });
    if (run.sourceMessageId)
      await this.chat.react(run.sourceMessageId, result.stopped ? '⏹️' : result.ok ? '✅' : '⚠️');
    this.preferSlot.delete(run.id);
    try {
      const answerId = await this.chat.say(result.text, run.sourceMessageId ? { replyTo: run.sourceMessageId } : {});
      this.pool.link(answerId, run.id);
    } catch (e) {
      this.ctx.logger.warn({ err: errMsg(e) }, 'could not send the task result');
    }
    this.gate.touch();
  }

  private finish(
    id: string,
    status: 'done' | 'failed' | 'stopped' | 'interrupted',
    extra: { result?: string; error?: string; toolCalls?: number; tainted?: boolean },
  ): void {
    this.ctx.db
      .update(operatorRuns)
      .set({
        status,
        finishedAt: this.ctx.clock.now(),
        ...(extra.result !== undefined ? { resultPreview: truncate(extra.result, 500) } : {}),
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        ...(extra.toolCalls !== undefined ? { toolCalls: extra.toolCalls } : {}),
        ...(extra.tainted !== undefined ? { tainted: extra.tainted } : {}),
      })
      .where(eq(operatorRuns.id, id))
      .run();
  }

  /** Running tasks first, then waiting ones; /cancel takes the number shown here. */
  list(): { n: number; runId: string; prompt: string; running: boolean }[] {
    const rows = [
      ...this.pool.running().map((r) => ({ runId: r.runId, prompt: r.prompt, running: true })),
      ...this.queued().map((r) => ({ runId: r.id, prompt: r.prompt, running: false })),
    ];
    return rows.map((r, i) => ({ n: i + 1, ...r }));
  }

  describe(): string {
    const rows = this.list();
    if (!rows.length) return 'Nothing running or queued.';
    const line = (r: (typeof rows)[number]) =>
      `${r.n}. ${truncate(r.prompt.replace(/\s+/g, ' '), 60)}${r.running ? '' : ' (waiting)'}`;
    return `${rows.map(line).join('\n')}\n\nSay "cancel 2" (any number) to stop or drop one.`;
  }

  /** Stop a running task or drop a waiting one by its /queue number. */
  async cancel(n: number): Promise<string | null> {
    const row = this.list().find((r) => r.n === n);
    if (!row) return null;
    if (row.running) await this.pool.interrupt(row.runId);
    else
      this.ctx.db
        .update(operatorRuns)
        .set({ status: 'stopped', finishedAt: this.ctx.clock.now() })
        .where(and(eq(operatorRuns.id, row.runId), eq(operatorRuns.status, 'queued')))
        .run();
    audit(this.ctx, { actor: 'owner', action: 'run.cancelled', target: row.runId, outcome: row.running ? 'stop' : 'drop' });
    return row.prompt;
  }

  /** Drop everything waiting (used by /kill). */
  clearQueued(): number {
    return this.ctx.db
      .update(operatorRuns)
      .set({ status: 'stopped', finishedAt: this.ctx.clock.now() })
      .where(eq(operatorRuns.status, 'queued'))
      .run().changes;
  }

  /** On startup: runs that were in progress are reported back; queued ones wait for the next unlock. */
  async recover(): Promise<void> {
    const open = this.ctx.db
      .select()
      .from(operatorRuns)
      .where(inArray(operatorRuns.status, ['running']))
      .all();
    for (const r of open) {
      this.finish(r.id, 'interrupted', {});
      audit(this.ctx, { actor: 'system', action: 'run.interrupted', target: r.id, outcome: 'restart' });
      await this.chat.notify(`PC restarted during: "${truncate(r.prompt, 120)}". Send it again if still needed.`);
    }
  }
}
