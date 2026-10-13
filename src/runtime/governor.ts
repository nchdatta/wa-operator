import { eq } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { operatorState } from '../persistence/schema.js';

/**
 * Usage governor. Operator Mode shares the owner's Claude subscription with Claude Desktop.
 * Live owner tasks always go first; scheduled routines (phase 4) run only while usage is comfortable.
 * When the limit gets close, the owner gets a notice instead of a silent stall.
 */

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number | undefined;
  rateLimitType?: string | undefined;
  utilization?: number | undefined;
}

export type GovernorLevel = 'ok' | 'warning' | 'limited';

const ROUTINE_MAX_UTILIZATION = 0.7;

export class Governor {
  private info: RateLimitInfo | null = null;
  private notified: GovernorLevel = 'ok';

  constructor(
    private readonly ctx: AppContext,
    private readonly notify: (text: string) => Promise<void>,
  ) {
    // Pick up the last known state, so a restart while limited does not start tasks that will fail.
    try {
      const raw = ctx.db.select().from(operatorState).where(eq(operatorState.id, 1)).get()?.rateLimit;
      if (raw) {
        this.info = JSON.parse(raw) as RateLimitInfo;
        this.notified = this.level;
      }
    } catch {
      // no state yet
    }
  }

  get level(): GovernorLevel {
    const i = this.info;
    if (!i) return 'ok';
    if (i.status === 'rejected') return 'limited';
    if (i.status === 'allowed_warning' || (i.utilization ?? 0) >= 0.8) return 'warning';
    return 'ok';
  }

  /** Feed every `rate_limit_event` from the Claude session. */
  async update(info: RateLimitInfo): Promise<void> {
    this.info = info;
    this.ctx.db
      .update(operatorState)
      .set({ rateLimit: JSON.stringify(info) })
      .where(eq(operatorState.id, 1))
      .run();
    const level = this.level;
    if (level === this.notified) return;
    const resets = info.resetsAt ? ` It resets ${this.when(info.resetsAt)}.` : '';
    if (level === 'limited') {
      await this.notify(`⛔ The Claude subscription limit is reached, so I can't work right now.${resets}`);
    } else if (level === 'warning' && this.notified === 'ok') {
      const pct = info.utilization !== undefined ? ` (${Math.round(info.utilization * 100)}% used)` : '';
      await this.notify(
        `⚠️ Claude usage is close to the limit${pct}. Your tasks still go first; routines are paused.${resets}`,
      );
    } else if (level === 'ok') {
      await this.notify('✅ Claude usage is back to normal.');
    }
    audit(this.ctx, { actor: 'system', action: 'governor.level', outcome: level, metadata: { ...info } });
    this.notified = level;
  }

  /** Live owner tasks run unless the limit is actually hit. */
  canRunOwnerTask(): boolean {
    return this.level !== 'limited' || (this.info?.resetsAt ?? 0) * 1000 <= this.ctx.clock.now();
  }

  /** Scheduled routines wait whenever usage is high. */
  canRunRoutine(): boolean {
    return this.level === 'ok' && (this.info?.utilization ?? 0) < ROUTINE_MAX_UTILIZATION;
  }

  describe(): string {
    const i = this.info;
    if (!i) return 'no usage data yet';
    const pct = i.utilization !== undefined ? `${Math.round(i.utilization * 100)}% used` : i.status;
    return `${pct}${i.resetsAt ? `, resets ${this.when(i.resetsAt)}` : ''}`;
  }

  private when(resetsAtSec: number): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.ctx.config.BUSINESS_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(resetsAtSec * 1000));
  }
}
