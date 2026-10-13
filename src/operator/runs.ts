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
import type { OperatorSession, RunResult } from './session.js';

/**
 * Owner instructions as durable runs. One runs at a time; others wait as `queued` with a notice.
 * After a restart, a run that was in progress is reported back instead of silently lost.
 */
export class RunQueue {
  private draining = false;
  private runningSourceId: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly chat: OwnerChat,
    private readonly gate: Gate,
    private readonly session: OperatorSession,
    private readonly governor: Governor,
  ) {}

  /** Message ID of the owner message that started the running task (replies to it add to the task). */
  get runningSource(): string | null {
    return this.runningSourceId;
  }

  queuedCount(): number {
    return this.ctx.db.select({ n: count() }).from(operatorRuns).where(eq(operatorRuns.status, 'queued')).get()?.n ?? 0;
  }

  async enqueue(prompt: string, sourceMessageId: string | null): Promise<string> {
    const id = newId();
    const busy = this.session.busy || this.queuedCount() > 0;
    this.ctx.db
      .insert(operatorRuns)
      .values({ id, status: 'queued', prompt, sourceMessageId, createdAt: this.ctx.clock.now() })
      .run();
    if (busy) {
      if (sourceMessageId) await this.chat.react(sourceMessageId, '📥');
      await this.chat.notify('📥 Queued, after the current task.', sourceMessageId ? { replyTo: sourceMessageId } : {});
    }
    void this.drain();
    return id;
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (!this.gate.isUnlocked()) break; // queued runs wait for the next unlock
        const next = this.ctx.db
          .select()
          .from(operatorRuns)
          .where(eq(operatorRuns.status, 'queued'))
          .orderBy(asc(operatorRuns.createdAt))
          .limit(1)
          .get();
        if (!next) break;
        await this.execute(next);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(run: typeof operatorRuns.$inferSelect): Promise<void> {
    const now = this.ctx.clock.now();
    const claimed = this.ctx.db
      .update(operatorRuns)
      .set({ status: 'running', startedAt: now })
      .where(and(eq(operatorRuns.id, run.id), eq(operatorRuns.status, 'queued')))
      .run();
    if (claimed.changes !== 1) return;
    if (!this.governor.canRunOwnerTask()) {
      this.finish(run.id, 'failed', { error: 'usage limit' });
      await this.chat.notify(`⛔ Claude usage limit reached (${this.governor.describe()}). Try again later.`);
      return;
    }
    this.runningSourceId = run.sourceMessageId;
    if (run.sourceMessageId) await this.chat.react(run.sourceMessageId, '⏳');
    let result: RunResult;
    try {
      result = await this.session.runTask({ id: run.id, prompt: run.prompt, sourceMessageId: run.sourceMessageId });
    } catch (e) {
      result = {
        ok: false,
        text: `⚠️ Could not start the task: ${truncate(errMsg(e), 300)}`,
        stopped: false,
        toolCalls: 0,
        tainted: false,
      };
    } finally {
      this.runningSourceId = null;
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
    await this.chat.notify(result.text, run.sourceMessageId ? { replyTo: run.sourceMessageId } : {});
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
      await this.chat.notify(
        `⚠️ The PC restarted while I was working on: "${truncate(r.prompt, 120)}". Nothing after the restart was done. Send it again if you still need it.`,
      );
    }
  }
}
