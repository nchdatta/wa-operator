import { describe, expect, it } from 'vitest';
import { ApprovalEngine } from '../src/approvals/engine.js';
import {
  addLedger,
  addSchedule,
  closeMemory,
  duesByParty,
  ledgerReport,
  listSchedules,
  memoryBrief,
  remember,
  saveRoutine,
  takeDue,
} from '../src/business/store.js';
import { checkRule, nextRun, zonedTime } from '../src/business/time.js';
import { OwnerChat } from '../src/channels/owner-chat.js';
import { Inbound } from '../src/inbound.js';
import { Gate } from '../src/operator/gate.js';
import { OwnerQuestions } from '../src/operator/output.js';
import { RunQueue } from '../src/operator/runs.js';
import type { RunHandle, RunResult } from '../src/operator/session.js';
import { SessionPool, type Slot } from '../src/operator/pool.js';
import { classify } from '../src/operator/tiers.js';
import { buildPathPolicy } from '../src/operator/session.js';
import { Governor } from '../src/runtime/governor.js';
import { Scheduler } from '../src/runtime/scheduler.js';
import { HOUR, MINUTE } from '../src/shared/clock.js';
import { FakeChannel, flush, makeCtx, OWNER } from './helpers.js';

const TZ = 'Asia/Dhaka';

describe('schedule times', () => {
  it('converts local wall-clock time, including across daylight saving', () => {
    expect(zonedTime(2026, 10, 14, 8, 0, TZ)).toBe(Date.UTC(2026, 9, 14, 2, 0));
    // London: BST until 25 Oct 2026, GMT after.
    expect(zonedTime(2026, 10, 20, 8, 0, 'Europe/London')).toBe(Date.UTC(2026, 9, 20, 7, 0));
    expect(zonedTime(2026, 10, 27, 8, 0, 'Europe/London')).toBe(Date.UTC(2026, 9, 27, 8, 0));
  });

  it('finds the next daily, weekly, monthly and one-time run', () => {
    const now = Date.UTC(2026, 9, 13, 4, 0); // Tue 13 Oct, 10:00 Dhaka
    expect(nextRun({ repeat: 'daily', time: '08:00' }, now, TZ)).toBe(Date.UTC(2026, 9, 14, 2, 0));
    expect(nextRun({ repeat: 'daily', time: '21:00' }, now, TZ)).toBe(Date.UTC(2026, 9, 13, 15, 0));
    expect(nextRun({ repeat: 'weekly', time: '09:00', on: '5' }, now, TZ)).toBe(Date.UTC(2026, 9, 16, 3, 0)); // Fri
    expect(nextRun({ repeat: 'monthly', time: '10:00', on: '31' }, now, TZ)).toBe(Date.UTC(2026, 9, 31, 4, 0));
    expect(nextRun({ repeat: 'monthly', time: '10:00', on: '31' }, Date.UTC(2026, 10, 1), TZ)).toBe(
      Date.UTC(2026, 10, 30, 4, 0), // November has 30 days
    );
    expect(nextRun({ repeat: 'once', time: '10:00', on: '2026-10-12' }, now, TZ)).toBeNull();
    expect(checkRule({ repeat: 'weekly', time: '9:00', on: 'fri' })).toMatch(/0-6/);
    expect(checkRule({ repeat: 'daily', time: '25:00' })).toMatch(/HH:MM/);
  });
});

describe('business store', () => {
  it('ledger totals, top items and money owed', () => {
    const ctx = makeCtx();
    addLedger(ctx, [
      { kind: 'sale', amount: 2400, item: 'Rice', qty: 3 },
      { kind: 'sale', amount: 600, item: 'rice', qty: 1 },
      { kind: 'expense', amount: 1850, note: 'electricity' },
      { kind: 'due', amount: 1000, party: 'Karim' },
      { kind: 'due_paid', amount: 400, party: 'karim' },
      { kind: 'due', amount: 300, party: 'Rahim', day: '2026-10-01' },
    ]);
    const r = ledgerReport(ctx, '2026-10-13', '2026-10-13');
    expect(r.totals.sale).toBe(3000);
    expect(r.net).toBe(1150);
    expect(r.topItems[0]).toEqual({ item: 'rice', amount: 3000, qty: 4 });
    expect(duesByParty(ctx)).toEqual([
      { party: 'Karim', owed: 600 },
      { party: 'Rahim', owed: 300 },
    ]);
    expect(() => addLedger(ctx, [{ kind: 'sale', amount: -5 }])).toThrow(/bad amount/);
  });

  it('memory, open tasks and routines reach the system prompt; closed ones do not', () => {
    const ctx = makeCtx();
    remember(ctx, 'fact', 'Rice supplier is Karim Traders');
    const t = remember(ctx, 'task', 'Call the landlord about rent');
    saveRoutine(ctx, 'Month Close', 'Make the monthly sales PDF and send it');
    let brief = memoryBrief(ctx);
    expect(brief).toMatch(/Karim Traders/);
    expect(brief).toMatch(/landlord/);
    expect(brief).toMatch(/"month close"/);
    closeMemory(ctx, t);
    brief = memoryBrief(ctx);
    expect(brief).not.toMatch(/landlord/);
  });

  it('a due schedule fires once even after the PC was off, then moves on', () => {
    const ctx = makeCtx();
    addSchedule(ctx, { kind: 'remind', title: 'Pay rent', body: 'Pay rent', repeat: 'daily', time: '11:00' });
    expect(takeDue(ctx)).toHaveLength(0);
    ctx.clock.advance(3 * 24 * HOUR); // off for days
    expect(takeDue(ctx)).toHaveLength(1);
    expect(takeDue(ctx)).toHaveLength(0);
    addSchedule(ctx, {
      kind: 'remind',
      title: 'Once',
      body: 'x',
      repeat: 'once',
      time: '23:00',
      on: '2026-10-16',
    });
    ctx.clock.advance(24 * HOUR);
    takeDue(ctx);
    expect(listSchedules(ctx).map((s) => s.title)).toEqual(['Pay rent']);
  });
});

describe('business tool tiers', () => {
  it('records are free, but a change after outside content asks', () => {
    const ctx = makeCtx();
    const base = {
      policy: buildPathPolicy(ctx),
      knownDomains: new Set<string>(),
      overrides: new Map(),
      untrustedDirs: [],
    };
    const add = 'mcp__business__schedule_add';
    expect(classify(add, {}, ctx.config.home, { ...base, tainted: false }).tier).toBe('LOW');
    const tainted = classify(add, {}, ctx.config.home, { ...base, tainted: true });
    expect(tainted.tier).toBe('HIGH');
    expect(tainted.risks?.length).toBeGreaterThan(0);
    expect(classify('mcp__business__ledger_report', {}, ctx.config.home, { ...base, tainted: true }).tier).toBe('LOW');
  });
});

/** Records prompts and origins; finishes each task at once. */
class StubSession {
  handles: RunHandle[] = [];
  busy = false;
  currentRunId = null;
  currentSource = null;
  currentPrompt = null;
  info() {
    return { model: null, startedAt: null, failedServers: [] };
  }
  ensure() {}
  async runTask(h: RunHandle): Promise<RunResult> {
    this.handles.push(h);
    return { ok: true, text: 'report', stopped: false, toolCalls: 1, tainted: false };
  }
  addToRun() {
    return false;
  }
  async interrupt() {}
  kill() {}
  newSession() {}
  async shutdown() {}
}

function setup() {
  const ctx = makeCtx();
  const ch = new FakeChannel();
  const chat = new OwnerChat(ctx, ch);
  const gate = new Gate(ctx);
  const governor = new Governor(ctx, async () => {});
  const session = new StubSession();
  const pool = new SessionPool([session as unknown as Slot]);
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
  return { ctx, ch, gate, session, runs, inbound, scheduler: new Scheduler(ctx, chat, gate, runs) };
}

let n = 0;
const text = (t: string) => ({
  channel: 'whatsapp' as const,
  id: `wamid.b${++n}`,
  from: OWNER,
  at: Date.UTC(2026, 9, 13, 4, 0),
  text: t,
});

describe('scheduler', () => {
  it('sends reminders and runs scheduled tasks while locked, but owner messages still wait', async () => {
    const t = setup();
    await t.gate.setPin('482913');
    addSchedule(t.ctx, {
      kind: 'remind',
      title: 'Call supplier',
      body: 'Call supplier',
      repeat: 'daily',
      time: '10:30',
    });
    addSchedule(t.ctx, { kind: 'task', title: 'Sales check', body: 'check sales', repeat: 'daily', time: '10:30' });
    await t.runs.enqueue('owner job', 'wamid.x');
    t.ctx.clock.advance(31 * MINUTE);
    await t.scheduler.tick();
    await flush();
    expect(t.ch.texts().some((x) => /⏰ Reminder: Call supplier/.test(x))).toBe(true);
    expect(t.session.handles.map((h) => h.origin)).toEqual(['schedule']);
    expect(t.session.handles[0]?.prompt).toMatch(/Scheduled task "Sales check"/);
  });

  it('nothing fires while Operator Mode is turned off', async () => {
    const t = setup();
    addSchedule(t.ctx, { kind: 'remind', title: 'x', body: 'x', repeat: 'daily', time: '10:30' });
    t.gate.disable('owner');
    t.ctx.clock.advance(31 * MINUTE);
    await t.scheduler.tick();
    expect(t.ch.sent).toHaveLength(0);
  });
});

describe('phone commands', () => {
  it('/menu lists quick jobs and routines; a tap queues the routine', async () => {
    const t = setup();
    await t.gate.setPin('482913');
    saveRoutine(t.ctx, 'month close', 'Make the monthly report');
    await t.inbound.handle(text('/menu'));
    const list = t.ch.last('list');
    expect(list?.rows.map((r) => r.id)).toContain('menu:r:month close');
    await t.inbound.handle({
      channel: 'whatsapp',
      id: 'wamid.tap1',
      from: OWNER,
      at: t.ctx.clock.now(),
      button: { id: 'menu:r:month close' },
    });
    expect(t.ch.last('pin')).toBeDefined(); // locked: asks for the PIN, the job waits
  });

  it('/briefing sets one daily task and /briefing off removes it', async () => {
    const t = setup();
    await t.gate.setPin('482913');
    await t.gate.submitPin(t.gate.newPinToken('unlock'), '482913');
    await t.inbound.handle(text('/briefing 7:30'));
    await t.inbound.handle(text('/briefing 08:00'));
    expect(listSchedules(t.ctx).map((s) => [s.id, s.time])).toEqual([['briefing', '08:00']]);
    await t.inbound.handle(text('/briefing off'));
    expect(listSchedules(t.ctx)).toHaveLength(0);
  });
});
