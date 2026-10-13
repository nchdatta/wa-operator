import { desc } from 'drizzle-orm';
import type { AppContext } from './context.js';
import { auditEvents } from './persistence/schema.js';
import { scrubSecrets, truncate } from './security/redact.js';
import { newId } from './shared/ids.js';

export type Actor = (typeof auditEvents.$inferInsert)['actor'];

export interface AuditEntry {
  actor: Actor;
  action: string;
  target?: string | null;
  outcome: string;
  /** IDs, tiers and short previews only. Strings are scrubbed of known secrets and truncated. */
  metadata?: Record<string, unknown>;
}

export function audit(ctx: AppContext, e: AuditEntry): void {
  const meta = e.metadata ? scrubSecrets(truncate(JSON.stringify(e.metadata), 2000), ctx.secrets) : null;
  try {
    ctx.db
      .insert(auditEvents)
      .values({
        id: newId(),
        actor: e.actor,
        action: e.action,
        target: e.target ?? null,
        outcome: e.outcome,
        metadataJson: meta,
        createdAt: ctx.clock.now(),
      })
      .run();
  } catch (err) {
    // The audit log must never take a task down; the logger still has it.
    ctx.logger.error({ err: err instanceof Error ? err.message : String(err), action: e.action }, 'audit write failed');
  }
}

export function recentAudit(ctx: AppContext, limit: number) {
  return ctx.db
    .select()
    .from(auditEvents)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit)
    .all();
}
