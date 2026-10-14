import type { ApprovalEngine } from '../approvals/engine.js';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { AppContext } from '../context.js';
import type { Governor } from '../runtime/governor.js';
import { truncate } from '../security/redact.js';
import type { Gate } from './gate.js';
import type { OwnerQuestions } from './output.js';
import { OperatorSession, type RunHandle, type RunResult, type SessionInfo } from './session.js';

/**
 * Parallel task slots. Slot 0 is the main conversation and takes every task when it is free; while it is
 * busy, a new task starts in the next free slot instead of waiting. Each slot is its own Claude session,
 * so a slot is told what the others finished since its last task.
 */

export type Slot = Pick<
  OperatorSession,
  | 'busy'
  | 'currentRunId'
  | 'currentSource'
  | 'currentPrompt'
  | 'ensure'
  | 'runTask'
  | 'addToRun'
  | 'interrupt'
  | 'kill'
  | 'newSession'
  | 'shutdown'
  | 'info'
>;

export interface RunningTask {
  runId: string;
  prompt: string;
  sourceMessageId: string | null;
}

interface Finished {
  slot: number;
  prompt: string;
  text: string;
  at: number;
}

const NOTES_KEPT = 3;

export class SessionPool {
  private readonly finished: Finished[] = [];
  /** Sequence number of each slot's last task start. */
  private readonly lastStart: number[] = [];
  private seq = 0;

  constructor(private readonly slots: Slot[]) {}

  static create(
    ctx: AppContext,
    chat: OwnerChat,
    gate: Gate,
    approvals: ApprovalEngine,
    governor: Governor,
    questions: OwnerQuestions,
  ): SessionPool {
    const slots: OperatorSession[] = [];
    const pool = new SessionPool(slots);
    for (let i = 0; i < ctx.config.OPERATOR_PARALLEL; i++)
      slots.push(new OperatorSession(ctx, chat, gate, approvals, governor, questions, i, () => pool.runningCount() > 1));
    return pool;
  }

  get size(): number {
    return this.slots.length;
  }

  get busy(): boolean {
    return this.slots.some((s) => s.busy);
  }

  runningCount(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  running(): RunningTask[] {
    return this.slots
      .filter((s) => s.busy && s.currentRunId)
      .map((s) => ({ runId: s.currentRunId!, prompt: s.currentPrompt ?? '', sourceMessageId: s.currentSource }));
  }

  hasSource(messageId: string): boolean {
    return this.slots.some((s) => s.busy && s.currentSource === messageId);
  }

  /** Run on the main slot when free, else the next free one. The caller keeps within `size`. */
  runTask(handle: RunHandle): Promise<RunResult> {
    const i = this.slots.findIndex((s) => !s.busy);
    if (i < 0) return Promise.reject(new Error('all task slots are busy'));
    const since = this.lastStart[i] ?? 0;
    this.lastStart[i] = ++this.seq;
    const notes = this.finished.filter((f) => f.slot !== i && f.at > since).slice(-NOTES_KEPT);
    const prompt = notes.length
      ? `[Done in a parallel task meanwhile, for context only:\n${notes
          .map((f) => `- "${truncate(f.prompt, 120)}" → ${truncate(f.text.replace(/\s+/g, ' '), 300)}`)
          .join('\n')}]\n\n${handle.prompt}`
      : handle.prompt;
    return this.slots[i]!.runTask({ ...handle, prompt, title: handle.title ?? handle.prompt }).then((r) => {
      this.finished.push({ slot: i, prompt: handle.prompt, text: r.text, at: ++this.seq });
      if (this.finished.length > 20) this.finished.shift();
      return r;
    });
  }

  /**
   * Add the owner's text to a running task: the one started by `source`, or the only one running.
   * Returns false when it is unclear which task is meant.
   */
  addToRun(text: string, source?: string | null): boolean {
    const busy = this.slots.filter((s) => s.busy);
    const target = source ? busy.find((s) => s.currentSource === source) : busy.length === 1 ? busy[0] : undefined;
    return target ? target.addToRun(text) : false;
  }

  /** Stop one task by run id, or all running tasks. */
  async interrupt(runId?: string): Promise<void> {
    await Promise.all(
      this.slots.filter((s) => s.busy && (!runId || s.currentRunId === runId)).map((s) => s.interrupt()),
    );
  }

  kill(): void {
    for (const s of this.slots) s.kill();
  }

  newSession(): void {
    for (const s of this.slots) s.newSession();
  }

  /** Warm the main conversation; other slots start on their first task. */
  ensure(): void {
    this.slots[0]?.ensure();
  }

  info(): SessionInfo {
    return this.slots[0]?.info() ?? { model: null, startedAt: null, failedServers: [] };
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.slots.map((s) => s.shutdown()));
  }
}
