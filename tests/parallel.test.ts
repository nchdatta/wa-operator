import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalEngine } from '../src/approvals/engine.js';
import type { OwnerMessage } from '../src/channels/channel.js';
import { OwnerChat } from '../src/channels/owner-chat.js';
import { Inbound, isFollowUp } from '../src/inbound.js';
import { Gate } from '../src/operator/gate.js';
import { OwnerQuestions } from '../src/operator/output.js';
import { SessionPool, type Slot } from '../src/operator/pool.js';
import { RunQueue } from '../src/operator/runs.js';
import type { RunHandle, RunResult } from '../src/operator/session.js';
import { Governor } from '../src/runtime/governor.js';
import { FakeChannel, flush, makeCtx, OWNER } from './helpers.js';

/** One task slot: remembers what it was given and finishes when told to. */
class StubSlot {
  prompts: string[] = [];
  added: string[] = [];
  interrupted = false;
  private run: (RunHandle & { finish: (r: RunResult) => void }) | null = null;
  get busy() {
    return this.run !== null;
  }
  get currentRunId() {
    return this.run?.id ?? null;
  }
  get currentSource() {
    return this.run?.sourceMessageId ?? null;
  }
  get currentPrompt() {
    return this.run?.prompt ?? null;
  }
  info() {
    return { model: null, startedAt: null, failedServers: [] };
  }
  ensure() {}
  runTask(h: RunHandle): Promise<RunResult> {
    this.prompts.push(h.prompt);
    return new Promise((finish) => (this.run = { ...h, finish }));
  }
  complete(text = 'done', stopped = false) {
    const r = this.run;
    this.run = null;
    r?.finish({ ok: !stopped, text, stopped, toolCalls: 1, tainted: false });
  }
  addToRun(t: string) {
    this.added.push(t);
    return true;
  }
  async interrupt() {
    this.interrupted = true;
    this.complete('⏹️ Stopped.', true);
  }
  kill() {
    this.complete('⏹️ Killed.', true);
  }
  newSession() {}
  async shutdown() {}
}

function setup() {
  const ctx = makeCtx();
  const ch = new FakeChannel();
  const chat = new OwnerChat(ctx, ch);
  const gate = new Gate(ctx);
  const governor = new Governor(ctx, async () => {});
  const a = new StubSlot();
  const b = new StubSlot();
  const pool = new SessionPool([a, b] as unknown as Slot[]);
  const runs = new RunQueue(ctx, chat, gate, pool, governor);
  const inbound = new Inbound({
    ctx,
    chat,
    gate,
    approvals: new ApprovalEngine(ctx, chat, gate),
    questions: new OwnerQuestions(300_000),
    session: pool,
    runs,
    governor,
    operatorId: OWNER,
  });
  return { ch, gate, a, b, runs, inbound };
}

let n = 0;
const msg = (over: Partial<OwnerMessage>): OwnerMessage => ({
  channel: 'whatsapp',
  id: `wamid.par${++n}`,
  from: OWNER,
  at: Date.UTC(2026, 9, 14, 4, 0),
  ...over,
});

describe('parallel tasks', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.gate.setPin('482913');
    await t.inbound.handle(msg({ pin: { token: t.gate.newPinToken('unlock'), pin: '482913' } }));
  });

  it('a second task starts right away in the next slot; a third waits', async () => {
    await t.inbound.handle(msg({ text: 'make the weekly report' }));
    await t.inbound.handle(msg({ text: 'check today emails' }));
    await flush();
    expect(t.a.prompts).toEqual(['make the weekly report']);
    expect(t.b.prompts).toEqual(['check today emails']);
    expect(t.ch.texts().some((x) => /Queued/.test(x))).toBe(false);
    await t.inbound.handle(msg({ text: 'who owes us money' }));
    expect(t.ch.texts().at(-1)).toMatch(/Queued #1/);
    t.b.complete('2 emails, nothing urgent.');
    await flush();
    await flush();
    // The freed slot takes the waiting task, told what the other slot finished.
    expect(t.a.prompts).toHaveLength(1);
    expect(t.b.prompts[1]).toBe('who owes us money');
  });

  it('the main slot hears what a parallel task finished', async () => {
    await t.inbound.handle(msg({ text: 'long report' }));
    await t.inbound.handle(msg({ text: 'quick email check' }));
    await flush();
    t.b.complete('2 emails, nothing urgent.');
    t.a.complete('report sent');
    await flush();
    await flush();
    await t.inbound.handle(msg({ text: 'anything else?' }));
    await flush();
    expect(t.a.prompts[1]).toMatch(/quick email check" → 2 emails, nothing urgent/);
    expect(t.a.prompts[1]).toMatch(/anything else\?$/);
  });

  it('/queue lists tasks and /cancel stops or drops one', async () => {
    await t.inbound.handle(msg({ text: 'task one' }));
    await t.inbound.handle(msg({ text: 'task two' }));
    await t.inbound.handle(msg({ text: 'task three' }));
    await flush();
    await t.inbound.handle(msg({ text: '/queue' }));
    expect(t.ch.texts().at(-1)).toMatch(/1\. ⚙️ task one\n2\. ⚙️ task two\n3\. 📥 task three/);
    await t.inbound.handle(msg({ text: '/cancel 3' }));
    expect(t.ch.texts().at(-1)).toMatch(/Stopped: task three/);
    await t.inbound.handle(msg({ text: '/cancel 1' }));
    expect(t.a.interrupted).toBe(true);
    await flush();
    expect(t.runs.queuedCount()).toBe(0);
  });

  it('a reply to a task, or a short "continue" while one runs, joins that task', async () => {
    const first = msg({ text: 'open chatgpt and make a banner' });
    await t.inbound.handle(first);
    await flush();
    await t.inbound.handle(msg({ text: 'continue with full trust mode' }));
    expect(t.a.added).toEqual(['continue with full trust mode']);
    expect(t.b.prompts).toHaveLength(0);
    await t.inbound.handle(msg({ text: 'sales today?' }));
    await flush();
    expect(t.b.prompts).toEqual(['sales today?']);
    // Two running: a plain "continue" is unclear, but a reply to the first task's message is not.
    await t.inbound.handle(msg({ text: 'make it blue', replyToId: first.id }));
    expect(t.a.added).toEqual(['continue with full trust mode', 'make it blue']);
  });

  it('follow-up detection stays narrow', () => {
    expect(isFollowUp('continue with the last task')).toBe(true);
    expect(isFollowUp('Okay')).toBe(true);
    expect(isFollowUp('চালিয়ে যাও')).toBe(true);
    expect(isFollowUp('okay now make the weekly sales report as pdf and send it to me')).toBe(false);
    expect(isFollowUp('yesterday sales?')).toBe(false);
  });
});

describe('owner questions', () => {
  it('each slot keeps its own open question', async () => {
    const q = new OwnerQuestions(300_000);
    const a = q.ask([], async () => {}, '0');
    const b = q.ask([], async () => {}, '1');
    q.cancel('1');
    expect(await b).toBeNull();
    expect(q.onText('yes')).toBe(true);
    expect(await a).toBe('yes');
  });
});
