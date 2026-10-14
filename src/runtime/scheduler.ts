import { audit } from '../audit.js';
import { takeDue, type Schedule } from '../business/store.js';
import { formatWhen } from '../business/time.js';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { AppContext } from '../context.js';
import type { Gate } from '../operator/gate.js';
import type { RunQueue } from '../operator/runs.js';
import { errMsg } from '../shared/errors.js';

const TICK_MS = 30_000;
/** Fired this late (PC was off or asleep): say so. */
const LATE_MS = 15 * 60_000;

/**
 * Fires reminders and scheduled tasks. Reminders are sent as they are; tasks go into the run queue
 * like an owner message, marked as scheduled.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly chat: OwnerChat,
    private readonly gate: Gate,
    private readonly runs: RunQueue,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.gate.state().enabled) return; // turned off or locked out: nothing fires
      for (const s of takeDue(this.ctx)) await this.fire(s);
    } catch (e) {
      this.ctx.logger.error({ err: errMsg(e) }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async fire(s: Schedule): Promise<void> {
    const now = this.ctx.clock.now();
    const late =
      s.nextAt !== null && now - s.nextAt > LATE_MS
        ? ` (late: due ${formatWhen(s.nextAt, this.ctx.config.BUSINESS_TIMEZONE)}, the PC was off)`
        : '';
    audit(this.ctx, { actor: 'system', action: `schedule.${s.kind}`, target: s.id, outcome: late ? 'late' : 'ok' });
    if (s.kind === 'remind') {
      await this.chat.notify(`⏰ Reminder: ${s.title}${late}\n${s.body === s.title ? '' : s.body}`.trim());
      return;
    }
    await this.chat.notify(`🔁 Starting scheduled task: ${s.title}${late}`);
    await this.runs.enqueue(
      `[Scheduled task "${s.title}", set up earlier. Do it now and report the result briefly.]\n${s.body}`,
      null,
      'schedule',
    );
  }
}
