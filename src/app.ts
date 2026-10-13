import fs from 'node:fs';
import { ApprovalEngine } from './approvals/engine.js';
import type { Channel } from './channels/channel.js';
import { OwnerChat } from './channels/owner-chat.js';
import { parseWhatsAppWebhook } from './channels/whatsapp.js';
import type { TelegramChannel, TgUpdate } from './channels/telegram.js';
import type { AppContext } from './context.js';
import { Inbound } from './inbound.js';
import { WebhookPayload } from './meta/webhook-schema.js';
import { Gate } from './operator/gate.js';
import { OwnerQuestions } from './operator/output.js';
import { RunQueue } from './operator/runs.js';
import { OperatorSession } from './operator/session.js';
import { Governor } from './runtime/governor.js';
import { JobProcessor } from './runtime/jobs.js';

export interface OperatorApp {
  chat: OwnerChat;
  gate: Gate;
  approvals: ApprovalEngine;
  governor: Governor;
  questions: OwnerQuestions;
  session: OperatorSession;
  runs: RunQueue;
  inbound: Inbound;
  processor: JobProcessor;
  /** Expire stale approvals, report interrupted runs, warm the session, start processing. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Wire every part together. The channel decides WhatsApp vs Telegram; nothing else does. */
export function createOperatorApp(
  ctx: AppContext,
  channel: Channel,
  opts: { markRead?: (id: string) => Promise<void>; warm?: boolean } = {},
): OperatorApp {
  const chat = new OwnerChat(ctx, channel);
  const gate = new Gate(ctx);
  const approvals = new ApprovalEngine(ctx, chat, gate);
  const governor = new Governor(ctx, (t) => chat.notify(t));
  const questions = new OwnerQuestions(ctx.config.OPERATOR_APPROVAL_TTL_SECONDS * 1000);
  const session = new OperatorSession(ctx, chat, gate, approvals, governor, questions);
  const runs = new RunQueue(ctx, chat, gate, session, governor);
  const operatorId = channel.name === 'whatsapp' ? ctx.config.OPERATOR_WA_ID! : ctx.config.TELEGRAM_OPERATOR_USER_ID!;
  const inbound = new Inbound({
    ctx,
    chat,
    gate,
    approvals,
    questions,
    session,
    runs,
    governor,
    operatorId,
    ...(opts.markRead ? { markRead: opts.markRead } : {}),
  });

  const processor = new JobProcessor(ctx, {
    whatsapp_webhook: async (payload) => {
      const parsed = WebhookPayload.parse(JSON.parse(payload));
      for (const m of parseWhatsAppWebhook(parsed, ctx.config.WHATSAPP_PHONE_NUMBER_ID ?? '')) await inbound.handle(m);
    },
    telegram_update: async (payload) => {
      const m = await (channel as TelegramChannel).normalize(JSON.parse(payload) as TgUpdate);
      if (m) await inbound.handle(m);
    },
  });

  return {
    chat,
    gate,
    approvals,
    governor,
    questions,
    session,
    runs,
    inbound,
    processor,
    async start() {
      for (const dir of [ctx.config.inbox, ctx.config.outbox]) fs.mkdirSync(dir, { recursive: true });
      gate.state();
      const expired = approvals.recover();
      if (expired) ctx.logger.info({ expired }, 'expired approvals left open by the last run');
      await runs.recover();
      processor.start();
      if (opts.warm !== false && gate.state().enabled) session.ensure();
    },
    async stop() {
      processor.stop();
      await session.shutdown();
    },
  };
}
