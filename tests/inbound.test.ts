import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalEngine } from '../src/approvals/engine.js';
import type { OwnerMessage } from '../src/channels/channel.js';
import { OwnerChat } from '../src/channels/owner-chat.js';
import { parseWhatsAppWebhook } from '../src/channels/whatsapp.js';
import { Inbound } from '../src/inbound.js';
import { WebhookPayload } from '../src/meta/webhook-schema.js';
import { Gate } from '../src/operator/gate.js';
import { OwnerQuestions } from '../src/operator/output.js';
import { RunQueue } from '../src/operator/runs.js';
import type { OperatorSession, RunHandle, RunResult } from '../src/operator/session.js';
import { auditEvents, jobs, operatorRuns } from '../src/persistence/schema.js';
import { Governor } from '../src/runtime/governor.js';
import { createWebhookApp } from '../src/webhook/app.js';
import { sign } from '../src/webhook/signature.js';
import { FakeChannel, flush, makeCtx, OWNER, STRANGER } from './helpers.js';

/** Stands in for the Agent SDK session: records prompts, finishes when told to. */
class StubSession {
  prompts: string[] = [];
  killed = false;
  interrupted = false;
  private finish: ((r: RunResult) => void) | null = null;
  get busy() {
    return this.finish !== null;
  }
  get currentRunId() {
    return null;
  }
  ensure() {}
  runTask(h: RunHandle): Promise<RunResult> {
    this.prompts.push(h.prompt);
    return new Promise((r) => (this.finish = r));
  }
  complete(text = 'done') {
    const f = this.finish;
    this.finish = null;
    f?.({ ok: true, text, stopped: false, toolCalls: 1, tainted: false });
  }
  addToRun(t: string) {
    this.prompts.push(`+${t}`);
    return true;
  }
  async interrupt() {
    this.interrupted = true;
  }
  kill() {
    this.killed = true;
    const f = this.finish;
    this.finish = null;
    f?.({ ok: false, text: '⏹️ Killed.', stopped: true, toolCalls: 0, tainted: false });
  }
  newSession() {}
  async shutdown() {}
}

function setup() {
  const ctx = makeCtx();
  const ch = new FakeChannel();
  const chat = new OwnerChat(ctx, ch);
  const gate = new Gate(ctx);
  const approvals = new ApprovalEngine(ctx, chat, gate);
  const governor = new Governor(ctx, async () => {});
  const questions = new OwnerQuestions(300_000);
  const session = new StubSession();
  const runs = new RunQueue(ctx, chat, gate, session as unknown as OperatorSession, governor);
  const inbound = new Inbound({
    ctx,
    chat,
    gate,
    approvals,
    questions,
    session: session as unknown as OperatorSession,
    runs,
    governor,
    operatorId: OWNER,
  });
  return { ctx, ch, gate, session, runs, inbound };
}

let n = 0;
const msg = (over: Partial<OwnerMessage>): OwnerMessage => ({
  channel: 'whatsapp',
  id: `wamid.in${++n}`,
  from: OWNER,
  at: Date.UTC(2026, 9, 13, 4, 0),
  ...over,
});

describe('inbound', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.gate.setPin('482913');
  });

  it('a message from any other number never reaches Operator Mode, even commands or a PIN', async () => {
    const pinTok = t.gate.newPinToken('unlock');
    await t.inbound.handle(msg({ from: STRANGER, text: 'delete everything' }));
    await t.inbound.handle(msg({ from: STRANGER, text: '/kill' }));
    await t.inbound.handle(msg({ from: STRANGER, pin: { token: pinTok, pin: '482913' } }));
    await t.inbound.handle(msg({ from: STRANGER, button: { id: 'apv:a:01JABCDEFGHJKMNPQRSTVWXYZ0' } }));
    expect(t.ch.sent).toHaveLength(0);
    expect(t.session.prompts).toHaveLength(0);
    expect(t.gate.isUnlocked()).toBe(false);
    expect(t.ctx.db.select().from(operatorRuns).all()).toHaveLength(0);
    const dropped = t.ctx.db
      .select()
      .from(auditEvents)
      .all()
      .filter((a) => a.action === 'inbound.dropped');
    expect(dropped).toHaveLength(4);
  });

  it('first message asks for the PIN through the Flow, then runs after unlock', async () => {
    await t.inbound.handle(msg({ text: "What's today?" }));
    const pin = t.ch.last('pin');
    expect(pin?.prompt).toMatch(/Unlock Operator Mode/);
    expect(t.session.prompts).toHaveLength(0);
    await t.inbound.handle(msg({ pin: { token: pin!.token, pin: '482913' } }));
    await flush();
    expect(t.session.prompts).toEqual(["What's today?"]);
    // The PIN never appears in any message we sent.
    expect(t.ch.texts().join('\n')).not.toContain('482913');
    t.session.complete('📅 11am supplier call.');
    await flush();
    await flush();
    expect(t.ch.texts().at(-1)).toContain('11am supplier call');
  });

  it('3 wrong PINs lock Operator Mode; only the PC can re-enable it', async () => {
    await t.inbound.handle(msg({ text: 'hi' }));
    for (const bad of ['000001', '000002', '000003']) {
      const pin = t.ch.last('pin')!;
      await t.inbound.handle(msg({ pin: { token: pin.token, pin: bad } }));
    }
    expect(t.ch.texts().at(-1)).toMatch(/locked until it is re-enabled at the PC/);
    expect(t.gate.state().enabled).toBe(false);
    await t.inbound.handle(msg({ text: 'please' }));
    expect(t.ch.texts().at(-1)).toMatch(/wa-operator enable/);
  });

  it('a second instruction while busy is queued with a notice', async () => {
    const tok = t.gate.newPinToken('unlock');
    await t.inbound.handle(msg({ pin: { token: tok, pin: '482913' } }));
    await t.inbound.handle(msg({ text: 'first' }));
    await flush();
    await t.inbound.handle(msg({ text: 'second' }));
    expect(t.ch.texts().at(-1)).toMatch(/Queued/);
    expect(t.session.prompts).toEqual(['first']);
    t.session.complete();
    await flush();
    await flush();
    expect(t.session.prompts).toEqual(['first', 'second']);
  });

  it('/kill stops the running task and locks within 1 second', async () => {
    const tok = t.gate.newPinToken('unlock');
    await t.inbound.handle(msg({ pin: { token: tok, pin: '482913' } }));
    await t.inbound.handle(msg({ text: 'long job' }));
    await flush();
    const started = performance.now();
    await t.inbound.handle(msg({ text: '/kill' }));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(t.session.killed).toBe(true);
    expect(t.gate.isUnlocked()).toBe(false);
  });

  it('a re-delivered message is handled once', async () => {
    const m = msg({ text: '/status' });
    await t.inbound.handle(m);
    await t.inbound.handle(m);
    expect(t.ch.texts()).toHaveLength(1);
  });

  it('a stale button does nothing', async () => {
    await t.inbound.handle(msg({ button: { id: 'apv:a:01JABCDEFGHJKMNPQRSTVWXYZ0' } }));
    expect(t.ch.texts().at(-1)).toMatch(/no longer open/);
  });
});

describe('WhatsApp webhook', () => {
  const payload = (from: string, extra: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1234567890' },
              messages: [{ from, id: `wamid.${Math.random()}`, timestamp: '1760000000', ...extra }],
            },
          },
        ],
      },
    ],
  });

  it('verifies the signature, stores the delivery once and answers fast', async () => {
    const { ctx } = setup();
    const app = createWebhookApp(ctx);
    const body = JSON.stringify(payload(OWNER, { type: 'text', text: { body: 'hi' } }));
    await request(app).post(ctx.config.WEBHOOK_PATH).set('content-type', 'application/json').send(body).expect(401);
    const sig = sign(body, ctx.config.META_APP_SECRET!);
    const started = performance.now();
    await request(app)
      .post(ctx.config.WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sig)
      .send(body)
      .expect(200);
    expect(performance.now() - started).toBeLessThan(500);
    await request(app)
      .post(ctx.config.WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sig)
      .send(body)
      .expect(200);
    expect(ctx.db.select().from(jobs).all()).toHaveLength(1);
  });

  it('parses text, buttons, PIN Flow replies and media', () => {
    const parse = (extra: Record<string, unknown>) =>
      parseWhatsAppWebhook(WebhookPayload.parse(payload(OWNER, extra)), '1234567890')[0]!;
    expect(parse({ type: 'text', text: { body: 'hello' } }).text).toBe('hello');
    expect(
      parse({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'apv:a:x', title: 'ok' } },
      }).button?.id,
    ).toBe('apv:a:x');
    expect(
      parse({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"flow_token":"abc","pin":"482913"}' } },
      }).pin,
    ).toEqual({ token: 'abc', pin: '482913' });
    expect(
      parse({ type: 'document', document: { id: 'm1', mime_type: 'application/pdf', filename: 'pricelist.pdf' } })
        .media,
    ).toMatchObject({
      kind: 'document',
      ref: 'm1',
      filename: 'pricelist.pdf',
    });
    expect(
      parseWhatsAppWebhook(WebhookPayload.parse(payload(OWNER, { type: 'text', text: { body: 'x' } })), 'other'),
    ).toHaveLength(0);
  });
});
