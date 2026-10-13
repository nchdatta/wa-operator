import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEngine, approvalButton } from '../src/approvals/engine.js';
import { OwnerChat } from '../src/channels/owner-chat.js';
import { Gate, msUntilMidnight } from '../src/operator/gate.js';
import { operatorState, proposedActions } from '../src/persistence/schema.js';
import { Governor } from '../src/runtime/governor.js';
import { MINUTE } from '../src/shared/clock.js';
import { chunkText } from '../src/shared/text.js';
import { FakeChannel, flush, makeCtx } from './helpers.js';

describe('gate', () => {
  it('unlocks until midnight with the right PIN and locks after idle time', async () => {
    const ctx = makeCtx({ OPERATOR_IDLE_MIN: '30' });
    const gate = new Gate(ctx);
    await gate.setPin('482913');
    expect(gate.isUnlocked()).toBe(false);
    const r = await gate.submitPin(gate.newPinToken('unlock'), '482913');
    expect(r.ok).toBe(true);
    expect(gate.isUnlocked()).toBe(true);
    expect(gate.state().unlockedUntil).toBe(ctx.clock.now() + msUntilMidnight(ctx.clock.now(), 'Asia/Dhaka'));
    ctx.clock.advance(31 * MINUTE);
    expect(gate.isUnlocked()).toBe(false);
  });

  it('3 wrong PINs lock Operator Mode until re-enabled at the PC', async () => {
    const ctx = makeCtx();
    const gate = new Gate(ctx);
    await gate.setPin('482913');
    expect(await gate.submitPin(gate.newPinToken('unlock'), '111111')).toMatchObject({ reason: 'wrong', remaining: 2 });
    expect(await gate.submitPin(gate.newPinToken('unlock'), '222222')).toMatchObject({ reason: 'wrong', remaining: 1 });
    expect(await gate.submitPin(gate.newPinToken('unlock'), '333333')).toMatchObject({ reason: 'locked_out' });
    // Even the right PIN does nothing now.
    expect(await gate.submitPin(gate.newPinToken('unlock'), '482913')).toMatchObject({
      ok: false,
      reason: 'locked_out',
    });
    expect(gate.isUnlocked()).toBe(false);
    gate.enable();
    expect((await gate.submitPin(gate.newPinToken('unlock'), '482913')).ok).toBe(true);
  });

  it('a PIN token works once and expires', async () => {
    const ctx = makeCtx();
    const gate = new Gate(ctx);
    await gate.setPin('482913');
    const t = gate.newPinToken('unlock');
    expect((await gate.submitPin(t, '482913')).ok).toBe(true);
    expect(await gate.submitPin(t, '482913')).toMatchObject({ reason: 'bad_token' });
    const t2 = gate.newPinToken('unlock');
    ctx.clock.advance(11 * MINUTE);
    expect(await gate.submitPin(t2, '482913')).toMatchObject({ reason: 'bad_token' });
  });

  it('rejects weak PINs and accepts an env hash', async () => {
    const ctx = makeCtx();
    const gate = new Gate(ctx);
    await expect(gate.setPin('1111')).rejects.toThrow();
    await expect(gate.setPin('1234')).rejects.toThrow();
    await expect(gate.setPin('12a4')).rejects.toThrow();
    const ctx2 = makeCtx({ OPERATOR_PIN_HASH: await hash('975310') });
    const g2 = new Gate(ctx2);
    expect(g2.hasPin()).toBe(true);
    expect((await g2.submitPin(g2.newPinToken('unlock'), '975310')).ok).toBe(true);
  });
});

describe('approval engine', () => {
  let ctx: ReturnType<typeof makeCtx>;
  let ch: FakeChannel;
  let engine: ApprovalEngine;
  let gate: Gate;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ctx = makeCtx();
    ch = new FakeChannel();
    gate = new Gate(ctx);
    engine = new ApprovalEngine(ctx, new OwnerChat(ctx, ch), gate);
  });
  afterEach(() => vi.useRealTimers());

  const req = (tier: 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'HIGH') => ({
    runId: null,
    toolUseId: 'tu1',
    toolName: 'mcp__gmail__send_email',
    input: { to: 'karim@karimtextiles.com', body: 'Confirming 200 pcs by 20 Oct.' },
    tier,
    reason: 'sends an email',
  });
  const advance = async (ms: number) => {
    ctx.clock.advance(ms);
    await vi.advanceTimersByTimeAsync(ms);
  };
  const cardId = () => {
    const b = ch.last('buttons')!;
    expect(b.body).toContain('karim@karimtextiles.com');
    return b.buttons[0]!.id.split(':')[2]!;
  };

  it('an approval answered after 4 minutes still works', async () => {
    const p = engine.request(req());
    await flush();
    const id = cardId();
    await advance(4 * MINUTE);
    await engine.onButton(approvalButton('a', id));
    await expect(p).resolves.toEqual({ decision: 'approved' });
  });

  it('after 5 minutes it is denied cleanly and a late tap does nothing', async () => {
    const p = engine.request(req());
    await flush();
    const id = cardId();
    await advance(6 * MINUTE);
    await expect(p).resolves.toEqual({ decision: 'expired' });
    await engine.onButton(approvalButton('a', id));
    expect(ctx.db.select().from(proposedActions).where(eq(proposedActions.id, id)).get()!.status).toBe('expired');
    expect(ch.texts().at(-1)).toMatch(/no longer open/);
  });

  it('an approved action is decided once; a second tap is stale', async () => {
    const p = engine.request(req());
    await flush();
    const id = cardId();
    await engine.onButton(approvalButton('a', id));
    await expect(p).resolves.toEqual({ decision: 'approved' });
    await engine.onButton(approvalButton('r', id));
    expect(ctx.db.select().from(proposedActions).where(eq(proposedActions.id, id)).get()!.status).toBe('approved');
  });

  it('✏️ Edit sends the correction back to Claude', async () => {
    const p = engine.request(req());
    await flush();
    const id = cardId();
    await engine.onButton(approvalButton('e', id));
    expect(engine.takeEditNote('Say 250 pieces')).toBe(true);
    await expect(p).resolves.toEqual({ decision: 'edit', note: 'Say 250 pieces' });
  });

  it('CRITICAL needs the PIN: the approve button is refused, the PIN approves', async () => {
    await gate.setPin('482913');
    const p = engine.request(req('CRITICAL'));
    await flush();
    const id = ch.last('buttons')!.buttons[0]!.id.split(':')[2]!;
    expect(ch.last('buttons')!.buttons.map((b) => b.title)).toEqual(['❌ Cancel']);
    const pinReq = ch.last('pin')!;
    await engine.onButton(approvalButton('a', id)); // crafted approve tap
    expect(ctx.db.select().from(proposedActions).where(eq(proposedActions.id, id)).get()!.status).toBe('pending');
    const r = await gate.submitPin(pinReq.token, '482913');
    expect(r).toMatchObject({ ok: true, purpose: 'approval', approvalId: id });
    await engine.onPinApproved(id);
    await expect(p).resolves.toEqual({ decision: 'approved' });
  });

  it('MEDIUM cards have no edit button; cancel rejects', async () => {
    const p = engine.request(req('MEDIUM'));
    await flush();
    const b = ch.last('buttons')!;
    expect(b.buttons.map((x) => x.title)).toEqual(['✅ Approve', '❌ Cancel']);
    await engine.onButton(b.buttons[1]!.id);
    await expect(p).resolves.toEqual({ decision: 'rejected' });
  });

  it('recover() expires requests left open by a crash', async () => {
    void engine.request(req());
    await flush();
    const fresh = new ApprovalEngine(ctx, new OwnerChat(ctx, ch), gate);
    expect(fresh.recover()).toBe(1);
  });
});

describe('owner chat', () => {
  it('long output splits under 4,096 characters without breaking words', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
    const parts = chunkText(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join(' ')).toBe(text);
  });

  it('scrubs secrets and holds messages while the 24-hour window is closed', async () => {
    const ctx = makeCtx();
    const ch = new FakeChannel();
    const chat = new OwnerChat(ctx, ch);
    new Gate(ctx).state();
    ctx.db.update(operatorState).set({ lastOwnerMessageAt: ctx.clock.now() }).run();
    await chat.say('token is access-token-0123456789abcdef');
    expect(ch.texts()[0]).toBe('token is [REDACTED]');
    ch.open = false;
    await chat.say('report ready');
    expect(ch.sent.some((s) => s.kind === 'template')).toBe(true);
    expect(ch.texts()).not.toContain('report ready');
    ch.open = true;
    await chat.flushHeld();
    expect(ch.texts().at(-1)).toContain('report ready');
  });
});

describe('governor', () => {
  it('notifies once near the limit; live tasks run, routines wait', async () => {
    const ctx = makeCtx();
    const notes: string[] = [];
    const g = new Governor(ctx, async (t) => void notes.push(t));
    await g.update({ status: 'allowed', utilization: 0.5 });
    expect(g.canRunRoutine()).toBe(true);
    await g.update({ status: 'allowed_warning', utilization: 0.85 });
    await g.update({ status: 'allowed_warning', utilization: 0.9 });
    expect(notes).toHaveLength(1);
    expect(g.canRunOwnerTask()).toBe(true);
    expect(g.canRunRoutine()).toBe(false);
    await g.update({ status: 'rejected', resetsAt: Math.floor(ctx.clock.now() / 1000) + 3600 });
    expect(g.canRunOwnerTask()).toBe(false);
    expect(notes.at(-1)).toMatch(/limit is reached/);
  });
});
