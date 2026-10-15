import type { ApprovalEngine } from './approvals/engine.js';
import { audit } from './audit.js';
import {
  addSchedule,
  describeSchedule,
  describeSchedulePlain,
  getRoutine,
  listMemory,
  listRoutines,
  listSchedules,
  removeSchedule,
  useRoutine,
} from './business/store.js';
import { parseTime } from './business/time.js';
import type { OwnerMessage } from './channels/channel.js';
import type { OwnerChat } from './channels/owner-chat.js';
import type { AppContext } from './context.js';
import type { Gate } from './operator/gate.js';
import { looksGarbled, saveToInbox, transcribe } from './operator/media.js';
import type { OwnerQuestions } from './operator/output.js';
import type { RunQueue } from './operator/runs.js';
import type { SessionPool } from './operator/pool.js';
import { inboundMessages } from './persistence/schema.js';
import type { Governor } from './runtime/governor.js';
import { maskWaId, truncate } from './security/redact.js';
import { errMsg } from './shared/errors.js';

/**
 * Every inbound message passes these checks in a fixed order, so a button tap or a PIN never ends
 * up as a Claude prompt:
 *   0. sender is not the operator      → dropped, no reply, logged
 *   1. approval button / PIN / answer  → approval engine, gate, or the waiting question
 *   2. slash command                   → /stop /status /queue /cancel /new /trust /kill /lock /help
 *   3. everything else                 → (unlock if needed) → run queue → Claude
 */

const UNLOCK_PROMPT_COOLDOWN = 60_000;

const HELP = `Just tell me what you need, like you would tell a person. Text or voice, English or Bangla.

For example: "any new emails?" · "Acme paid 50k" · "who owes us money?" · "remind me 10am to call John" · "open ChatGPT and make a banner"

I only ask before sending, deleting or paying. Reply yes or no.

Quick words: stop · tasks · status · lock`;

const HELP_BN = `যা দরকার সাধারণভাবে লিখুন বা ভয়েসে বলুন, বাংলা বা ইংরেজিতে।

যেমন: "নতুন মেইল আছে?" · "Acme ৫০ হাজার দিসে" · "কে কে টাকা বাকি রাখসে?" · "কাল ১০টায় জনকে কল দিতে মনে করাইয়ো"

শুধু পাঠানো, মোছা বা টাকা দেওয়ার আগে জিজ্ঞেস করি। হ্যাঁ বা না লিখে উত্তর দিন।

ছোট শব্দ: থামো · কাজগুলা দেখাও · status · লক করো`;

/** Everyday phrases for the shortcuts, so nobody has to learn commands. Whole message only. */
const NATURAL: [RegExp, string][] = [
  [/^(stop|stp|stopp|sotp|stop it|stop all|cancel it|cancel all|থামো|থামাও|বন্ধ করো|thamo|bondho koro)$/, '/stop'],
  [/^(?:stop|cancel|cancle)(?: task| job)? (?:#|no\.? ?)?(\d{1,3})$/, '/cancel $1'],
  [/^(help|hlp|halp|hepl)$/, '/help'],
  [/^(সাহায্য|সাহায্য করো|হেল্প)$/, '/help bn'],
  [/^(menu)$/, '/menu'],
  [/^(status|staus|stauts|statsu)$/, '/status'],
  [/^(tasks|taks|tsaks|jobs|show tasks|show jobs|queue|কাজগুলা দেখাও|কাজগুলো দেখাও|কাজ দেখাও|kaj gula dekhao)$/, '/queue'],
  [/^(lock|লক করো|lock koro)$/, '/lock'],
  [/^(emergency stop)$/, '/kill'],
  [/^(start over|new chat|reset)$/, '/new'],
  [/^(full trust|trust full)$/, '/trust full'],
  [/^(trust on)$/, '/trust on'],
  [/^(trust off|ask me first)$/, '/trust off'],
  [/^(reminders|remindrs|show reminders)$/, '/reminders'],
  [/^(memory|show memory)$/, '/memory'],
];

/** "hi", "helo", "good morning", "হাই"… with nothing else asked. */
export function isGreeting(text: string): boolean {
  return /^(hi+|hey+|hello+|helo+|hlw|hii+|yo|salam|assalamu ?alaikum|good ?(morning|mrng|afternoon|evening|night)|gm|হাই|হ্যালো|সালাম|আসসালামু আলাইকুম)[\s!.,?]*$/iu.test(
    text.trim(),
  );
}

/** "stop", "start over", "show tasks"… → the matching shortcut, or null for an ordinary instruction. */
export function naturalCommand(text: string): string | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^(please|pls|plz|ok|okay|hey)[,\s]+/, '')
    .replace(/[,\s]+(please|pls|plz|now)$/, '')
    .replace(/[.!?।]+$/, '')
    .trim();
  if (t.length > 40) return null;
  for (const [re, cmd] of NATURAL) {
    const m = re.exec(t);
    if (m) return cmd.replace('$1', m[1] ?? '');
  }
  return null;
}

/** Short nudges that continue the running task instead of starting a new one. */
const FOLLOW_UP =
  /^(continue|go on|go ahead|carry on|proceed|keep going|resume|yes|yep|yeah|ok|okay|sure|do it|try again|retry|হ্যাঁ|ঠিক আছে|চালিয়ে যাও)(?![a-z])/i;

export function isFollowUp(text: string): boolean {
  const t = text.trim();
  return t.split(/\s+/).length <= 8 && FOLLOW_UP.test(t);
}

const BRIEFING = `Morning briefing. Keep it short, phone-sized:
1. Today's calendar and anything due today (open tasks, reminders).
2. Important unread emails from the last day (one line each, skip newsletters and promotions).
3. Yesterday's sales, expenses and net from the ledger, and the money owed list total.
4. Anything that needs my decision today.
Skip any part whose service is not connected, without comment.`;

const SUMMARY = `End-of-day summary. Keep it short, phone-sized:
1. Today's sales, expenses and net from the ledger.
2. What was done today, and what is still open (carry unfinished work forward as open tasks).
3. Reminders and scheduled tasks for tomorrow.`;

/** Quick jobs on /menu (title ≤ 24 characters). */
const MENU: { id: string; title: string; description: string; prompt?: string }[] = [
  {
    id: 'menu:today',
    title: "Today's summary",
    description: 'Sales, expenses, money owed',
    prompt: "Give me today's business summary from the ledger: sales, expenses, net, and money owed.",
  },
  {
    id: 'menu:dues',
    title: 'Money owed',
    description: 'Who owes how much',
    prompt: 'Who owes us money? Biggest first.',
  },
  {
    id: 'menu:shot',
    title: 'Screenshot',
    description: 'See the PC screen',
    prompt: 'Take a screenshot and send it to me.',
  },
  { id: 'menu:remind', title: 'Reminders', description: 'Reminders and schedules' },
];

export interface InboundDeps {
  ctx: AppContext;
  chat: OwnerChat;
  gate: Gate;
  approvals: ApprovalEngine;
  questions: OwnerQuestions;
  session: SessionPool;
  runs: RunQueue;
  governor: Governor;
  /** Provider ID of the one allowed sender. */
  operatorId: string;
  markRead?: (messageId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export class Inbound {
  private lastUnlockPromptAt = 0;

  constructor(private readonly d: InboundDeps) {}

  async handle(m: OwnerMessage): Promise<void> {
    const { ctx, gate, chat } = this.d;
    // 0. Anyone but the operator gets silence.
    if (m.from !== this.d.operatorId) {
      audit(ctx, {
        actor: 'stranger',
        action: 'inbound.dropped',
        outcome: 'not_operator',
        metadata: { from: maskWaId(m.from), channel: m.channel },
      });
      return;
    }
    const fresh = ctx.db
      .insert(inboundMessages)
      .values({ id: `${m.channel}:${m.id}`, channel: m.channel, kind: this.kindOf(m), receivedAt: ctx.clock.now() })
      .onConflictDoNothing()
      .run();
    if (fresh.changes !== 1) return; // already handled (re-delivery)

    gate.recordOwnerMessage(Math.min(m.at, ctx.clock.now()));
    void chat.flushHeld();
    if (this.d.markRead && !m.id.startsWith('cb:')) void this.d.markRead(m.id);

    try {
      // 1. Buttons, PINs, answers.
      if (m.pin) return await this.onPin(m.pin.token, m.pin.pin);
      if (m.button) return await this.onButton(m.button.id);

      const text = (m.text ?? '').trim();
      // 2. Commands.
      const textPinToken = text ? chat.channel.takeTextPin?.(text, m.replyToId) : null;
      if (textPinToken) {
        void chat.channel
          .wipePin?.(m.id)
          .catch((e: unknown) => ctx.logger.debug({ err: errMsg(e) }, 'could not clean up the PIN message'));
        return await this.onPin(textPinToken, text);
      }
      if (text && (await this.d.approvals.answerTyped(text))) return;
      if (text.startsWith('/')) return await this.onCommand(text);
      const shortcut = text ? naturalCommand(text) : null;
      if (shortcut) return await this.onCommand(shortcut);

      // 3. Instructions.
      const s = gate.state();
      if (!s.enabled) {
        await chat.say(
          s.disabledReason === 'lockout'
            ? '🔒 Operator Mode is locked after 3 wrong PINs. Re-enable it at the PC: wa-operator enable'
            : 'Operator Mode is turned off. Turn it on at the PC: wa-operator enable',
        );
        return;
      }
      if (!gate.hasPin()) {
        await chat.say('No PIN is set yet. Set one at the PC first: wa-operator set-pin');
        return;
      }
      // A PIN with no request open (e.g. sent twice) must never reach Claude as an instruction.
      if (text && (await gate.isPin(text))) {
        await chat.say('That looks like your PIN, so I ignored it. Please delete that message from this chat.');
        return;
      }
      if (text && this.d.questions.onText(text)) return;
      if (text && this.d.approvals.takeEditNote(text)) return;

      const prompt = await this.toPrompt(m);
      if (!prompt) return;

      // A reply to a running task's message, or a short "continue" while one task runs, adds to that task.
      if (this.d.session.busy && gate.isUnlocked()) {
        const source = m.replyToId && this.d.session.hasSource(m.replyToId) ? m.replyToId : null;
        if ((source || isFollowUp(prompt)) && this.d.session.addToRun(prompt, source)) {
          await chat.react(m.id, '👍');
          return;
        }
      }
      // A reply to a finished task's request or answer continues in that task's conversation.
      const slot = m.replyToId ? this.d.session.slotFor(m.replyToId) : undefined;
      // While locked, a plain greeting or a repeat of a waiting message only asks for the PIN again:
      // otherwise "hi", "hi", "hello" become three separate answers after unlock.
      const waiting = this.d.runs.list().some((r) => !r.running && r.prompt.trim().toLowerCase() === prompt.toLowerCase());
      if (!gate.isUnlocked() && (isGreeting(prompt) || waiting)) return await this.requestUnlock();
      await this.d.runs.enqueue(prompt, m.id, 'owner', slot);
      if (!gate.isUnlocked()) await this.requestUnlock();
    } catch (e) {
      ctx.logger.error({ err: errMsg(e) }, 'inbound: failed to handle owner message');
      await chat.notify(`Sorry, that failed: ${truncate(errMsg(e), 200)}`);
    }
  }

  private kindOf(m: OwnerMessage): string {
    return m.pin ? 'pin' : m.button ? 'button' : m.media ? m.media.kind : m.text !== undefined ? 'text' : 'other';
  }

  private async toPrompt(m: OwnerMessage): Promise<string | null> {
    const { ctx, chat } = this.d;
    if (m.text !== undefined) return m.text.trim() || null;
    if (m.media) {
      if (m.media.kind === 'sticker') return null;
      const file = await saveToInbox(ctx, chat, m.media);
      audit(ctx, { actor: 'owner', action: 'inbound.media', outcome: m.media.kind, metadata: { file } });
      if (m.media.kind === 'audio') {
        if (!ctx.config.WHISPER_URL) {
          await chat.say(
            "I can't listen to voice notes. Tap the 🎤 on your keyboard and speak instead (Gboard and Samsung keyboards support Bangla); it arrives as text.",
          );
          return null;
        }
        const heard = await transcribe(ctx.config.WHISPER_URL, file, this.d.fetchImpl, ctx.config.WHISPER_LANG);
        if (!heard || looksGarbled(heard)) {
          await chat.say("Couldn't catch that. Say it again or type it.");
          return null;
        }
        await chat.say(`I heard: "${truncate(heard, 600)}"`, { replyTo: m.id, format: false });
        return heard;
      }
      const caption = m.media.caption?.trim() || `I sent a ${m.media.kind === 'image' ? 'photo' : 'file'}.`;
      return `${caption}\n\n[Attached ${m.media.kind} saved at: ${file}]`;
    }
    return null;
  }

  async requestUnlock(force = false): Promise<void> {
    const now = this.d.ctx.clock.now();
    if (!force && now - this.lastUnlockPromptAt < UNLOCK_PROMPT_COOLDOWN) return;
    this.lastUnlockPromptAt = now;
    const token = this.d.gate.newPinToken('unlock');
    await this.d.chat.requestPin(token, "Hi! I'm locked for safety.");
  }

  private async onPin(token: string, pin: string): Promise<void> {
    const { gate, chat, approvals, session, runs } = this.d;
    const r = await gate.submitPin(token, pin);
    if (r.ok) {
      if (r.purpose === 'unlock') {
        this.lastUnlockPromptAt = 0;
        const queued = runs.queuedCount();
        await chat.say(
          `${queued ? 'Unlocked. Working on it…' : 'Unlocked.'}\n_Delete your PIN message from this chat (hold it, then Delete for me)._`,
        );
        session.ensure();
        void runs.drain();
      } else if (r.approvalId) {
        await approvals.onPinApproved(r.approvalId);
      }
      return;
    }
    switch (r.reason) {
      case 'wrong':
        await chat.say(`Wrong PIN. ${r.remaining} ${r.remaining === 1 ? 'try' : 'tries'} left.`);
        if (r.purpose === 'unlock') await this.requestUnlock(true);
        else if (r.approvalId)
          await chat.requestPin(
            gate.newPinToken('approval', r.approvalId),
            'Enter your PIN to approve the critical action.',
          );
        return;
      case 'locked_out':
        session.kill();
        runs.clearQueued();
        await chat.say(
          '🔒 3 wrong PINs. Operator Mode is locked until it is re-enabled at the PC (wa-operator enable).',
        );
        return;
      case 'bad_token':
        await chat.say('That PIN form has expired or was already used.');
        if (!gate.isUnlocked() && runs.queuedCount() > 0) await this.requestUnlock(true);
        return;
      case 'no_pin':
        await chat.say('No PIN is set yet. Set one at the PC first: wa-operator set-pin');
        return;
      case 'disabled':
        await chat.say('Operator Mode is turned off at the PC.');
        return;
    }
  }

  private async onButton(id: string): Promise<void> {
    if (id.startsWith('menu:')) return await this.onMenu(id);
    if (await this.d.approvals.onButton(id)) return;
    if (this.d.questions.onButton(id)) return;
    await this.d.chat.say('That button is no longer active.');
  }

  private async onMenu(id: string): Promise<void> {
    const { ctx, chat, runs, gate } = this.d;
    if (id === 'menu:remind') return await this.onCommand('/reminders');
    let prompt = MENU.find((m) => m.id === id)?.prompt;
    if (id.startsWith('menu:r:')) {
      const r = getRoutine(ctx, id.slice('menu:r:'.length));
      if (r) {
        useRoutine(ctx, r.name);
        prompt = `Run my saved routine "${r.name}":\n${r.prompt}`;
      }
    }
    if (!prompt) {
      await chat.say('That menu item is no longer there. Say "menu" again.');
      return;
    }
    await runs.enqueue(prompt, null);
    if (!gate.isUnlocked()) await this.requestUnlock();
  }

  private async sendMenu(): Promise<void> {
    const rows = [
      ...MENU.map(({ id, title, description }) => ({ id, title, description })),
      ...listRoutines(this.d.ctx)
        .slice(0, 10 - MENU.length)
        .map((r) => ({
          id: `menu:r:${r.name}`,
          title: truncate(r.name, 24),
          description: truncate(r.prompt.replace(/\s+/g, ' '), 72),
        })),
    ];
    await this.d.chat.list('What do you need?', 'Menu', rows);
  }

  /** /briefing and /summary: one fixed daily task each, replaced on every change. */
  private async setDaily(id: 'briefing' | 'summary', arg: string): Promise<void> {
    const { ctx, chat } = this.d;
    const name = id === 'briefing' ? 'Morning briefing' : 'End-of-day summary';
    if (arg === 'off') {
      await chat.say(removeSchedule(ctx, id) ? `${name} turned off.` : `${name} was not on.`);
      return;
    }
    const t = parseTime(arg || (id === 'briefing' ? '08:00' : '21:00'));
    if (!t) {
      await chat.say(`Use /${id} 08:00 (24-hour time) or /${id} off.`);
      return;
    }
    const time = `${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}`;
    const s = addSchedule(ctx, {
      id,
      kind: 'task',
      title: name,
      body: id === 'briefing' ? BRIEFING : SUMMARY,
      repeat: 'daily',
      time,
    });
    await chat.say(
      `${describeSchedule(ctx, s)}\nIf Operator Mode is locked then, it only reads and reports; nothing is changed.`,
      { format: false },
    );
  }

  private async onCommand(text: string): Promise<void> {
    const { gate, chat, session, runs, governor } = this.d;
    const [cmd = '', arg = ''] = text.toLowerCase().split(/\s+/);
    switch (cmd) {
      case '/menu':
        await this.sendMenu();
        return;
      case '/help':
        await chat.say(arg === 'bn' ? HELP_BN : HELP, { format: false });
        return;
      case '/stop': {
        if (arg) return await this.onCommand(`/cancel ${arg}`);
        // Answer an open card with No first, so the job can't carry on while it stops.
        await this.d.approvals.answerTyped('no');
        const n = session.runningCount();
        if (!n) {
          await chat.say('Nothing is running.');
          return;
        }
        await chat.say(n > 1 ? `Stopping ${n} tasks…` : 'Stopping…');
        await session.interrupt();
        return;
      }
      case '/queue':
        await chat.say(runs.describe(), { format: false });
        return;
      case '/cancel': {
        const n = Number(arg);
        const prompt = Number.isInteger(n) && n > 0 ? await runs.cancel(n) : null;
        await chat.say(
          prompt ? `Stopped: ${truncate(prompt.replace(/\s+/g, ' '), 60)}` : 'No task with that number. Say "show tasks" to see them.',
        );
        return;
      }
      case '/kill': {
        session.kill();
        const dropped = runs.clearQueued();
        gate.lock('kill');
        audit(this.d.ctx, { actor: 'owner', action: 'command.kill', outcome: 'ok', metadata: { dropped } });
        await chat.say('Stopped everything and locked. Your next message will ask for the PIN.');
        return;
      }
      case '/lock':
        gate.lock('owner');
        await chat.say('🔒 Locked. Your next message will ask for the PIN.');
        return;
      case '/status': {
        const s = gate.state();
        const info = session.info();
        const now = this.d.ctx.clock.now();
        const mins = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;
        const idleLeft =
          gate.isUnlocked() && s.lastActivityAt !== null
            ? ` · locks in ${mins(s.lastActivityAt + this.d.ctx.config.OPERATOR_IDLE_MIN * 60_000 - now)} if quiet`
            : '';
        // Plain words only; model, usage details and offline connectors stay in the logs.
        const usage = governor.describe();
        const running = session.runningCount();
        const queued = runs.queuedCount();
        const lines = [
          s.enabled ? (gate.isUnlocked() ? `Ready${idleLeft}` : '🔒 Locked') : 'Turned off at the PC',
          session.busy ? `Working on ${running} job${running > 1 ? 's' : ''}` : 'Free',
          ...(queued ? [`${queued} waiting`] : []),
          s.fullTrust
            ? 'I only ask before sending, deleting or paying'
            : s.trusted
              ? 'I ask before most changes'
              : 'I ask before every change',
          ...(/^allowed/.test(usage) ? [] : [`${usage}`]),
        ];
        if (info.failedServers.length) this.d.ctx.logger.info({ offline: info.failedServers }, 'status: offline servers');
        await chat.say(lines.join('\n'), { format: false });
        return;
      }
    }
    // The rest need an unlocked session.
    if (!gate.isUnlocked()) {
      await chat.say('🔒 Unlock first.');
      await this.requestUnlock(true);
      return;
    }
    switch (cmd) {
      case '/reminders': {
        const rows = listSchedules(this.d.ctx);
        await chat.say(
          rows.length
            ? `${rows.map((s) => describeSchedulePlain(this.d.ctx, s)).join('\n')}\n\nTo remove one, just say which, e.g. "cancel the water reminder".`
            : 'No reminders or scheduled tasks. Try: "remind me Friday 6pm to call the supplier".',
          { format: false },
        );
        return;
      }
      case '/memory': {
        const rows = listMemory(this.d.ctx);
        await chat.say(
          rows.length
            ? `${rows.map((r) => `[${r.id}] ${r.kind === 'task' ? '' : '•'} ${r.text}`).join('\n')}\n\nTo remove one, say "forget" and its id.`
            : 'Nothing remembered yet. Try: "remember that our supplier for rice is Karim Traders".',
          { format: false },
        );
        return;
      }
      case '/briefing':
      case '/summary':
        await this.setDaily(cmd === '/briefing' ? 'briefing' : 'summary', arg);
        return;
      case '/new':
        if (session.busy) {
          await chat.say('A task is still running. Say "stop" first.');
          return;
        }
        session.newSession();
        session.ensure();
        await chat.say('🆕 Fresh conversation started.');
        return;
      case '/trust':
        if (arg !== 'on' && arg !== 'off' && arg !== 'full') {
          await chat.say('Say "full trust", "trust on" or "ask me first".');
          return;
        }
        gate.setTrusted(arg === 'full' ? 'full' : arg === 'on');
        await chat.say(
          arg === 'full'
            ? 'Full trust: I just do it. I still ask before sending, deleting, installing, paying, or opening a new site after reading a page.'
            : arg === 'on'
              ? 'Trust on: edits and browsing run. Commands, sends and deletes ask.'
              : 'Trust off: every change asks first.',
        );
        return;
      default:
        await chat.say("I don't know that shortcut. Just tell me what you need in your own words, or say \"help\".");
    }
  }
}
