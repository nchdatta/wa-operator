import type { ApprovalEngine } from './approvals/engine.js';
import { audit } from './audit.js';
import type { OwnerMessage } from './channels/channel.js';
import type { OwnerChat } from './channels/owner-chat.js';
import type { AppContext } from './context.js';
import type { Gate } from './operator/gate.js';
import { saveToInbox, transcribe } from './operator/media.js';
import type { OwnerQuestions } from './operator/output.js';
import type { RunQueue } from './operator/runs.js';
import type { OperatorSession } from './operator/session.js';
import { inboundMessages } from './persistence/schema.js';
import type { Governor } from './runtime/governor.js';
import { maskWaId, truncate } from './security/redact.js';
import { errMsg } from './shared/errors.js';

/**
 * Every inbound message passes these checks in a fixed order, so a button tap or a PIN never ends
 * up as a Claude prompt:
 *   0. sender is not the operator      → dropped, no reply, logged
 *   1. approval button / PIN / answer  → approval engine, gate, or the waiting question
 *   2. slash command                   → /stop /status /new /trust /kill /lock /help
 *   3. everything else                 → (unlock if needed) → run queue → Claude
 */

const UNLOCK_PROMPT_COOLDOWN = 60_000;

const HELP = `Operator Mode commands:
/stop – stop the current task
/status – what's going on
/new – start a fresh conversation
/trust on|full|off – on: edits run without asking; full: commands too (sends/deletes still ask)
/lock – lock until the next PIN
/kill – stop everything and lock
Anything else is an instruction for the PC.`;

export interface InboundDeps {
  ctx: AppContext;
  chat: OwnerChat;
  gate: Gate;
  approvals: ApprovalEngine;
  questions: OwnerQuestions;
  session: OperatorSession;
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
      if (textPinToken) return await this.onPin(textPinToken, text);
      if (text.startsWith('/')) return await this.onCommand(text);

      // 3. Instructions.
      const s = gate.state();
      if (!s.enabled) {
        await chat.say(
          s.disabledReason === 'lockout'
            ? '🔒 Operator Mode is locked after 3 wrong PINs. Re-enable it at the PC: wa-operator enable'
            : '⏸️ Operator Mode is turned off. Turn it on at the PC: wa-operator enable',
        );
        return;
      }
      if (!gate.hasPin()) {
        await chat.say('🔐 No PIN is set yet. Set one at the PC first: wa-operator set-pin');
        return;
      }
      if (text && this.d.questions.onText(text)) return;
      if (text && this.d.approvals.takeEditNote(text)) return;

      const prompt = await this.toPrompt(m);
      if (!prompt) return;

      // A reply to the running task's message adds to that task.
      if (this.d.session.busy && m.replyToId && m.replyToId === this.d.runs.runningSource && gate.isUnlocked()) {
        if (this.d.session.addToRun(prompt)) {
          await chat.react(m.id, '👍');
          return;
        }
      }
      await this.d.runs.enqueue(prompt, m.id);
      if (!gate.isUnlocked()) await this.requestUnlock();
    } catch (e) {
      ctx.logger.error({ err: errMsg(e) }, 'inbound: failed to handle owner message');
      await chat.notify(`⚠️ Sorry, that failed: ${truncate(errMsg(e), 200)}`);
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
      const file = await saveToInbox(ctx, chat, m.media, m.id);
      audit(ctx, { actor: 'owner', action: 'inbound.media', outcome: m.media.kind, metadata: { file } });
      if (m.media.kind === 'audio') {
        if (!ctx.config.WHISPER_URL) {
          await chat.say(
            "🎙️ I can't listen to voice notes. Tap the 🎤 on your keyboard and speak instead (Gboard and Samsung keyboards support Bangla); it arrives as text.",
          );
          return null;
        }
        const heard = await transcribe(ctx.config.WHISPER_URL, file, this.d.fetchImpl);
        if (!heard) {
          await chat.say("🎙️ I couldn't make out that voice note. Please type it or try again.");
          return null;
        }
        await chat.say(`🎙️ I heard: "${truncate(heard, 600)}"`, { replyTo: m.id, format: false });
        return heard;
      }
      const caption = m.media.caption?.trim() || `I sent a ${m.media.kind === 'image' ? 'photo' : 'file'}.`;
      return `${caption}\n\n[Attached ${m.media.kind} saved at: ${file}]`;
    }
    await chat.say('I can read text, photos, PDFs and documents. That kind of message is not supported.');
    return null;
  }

  async requestUnlock(force = false): Promise<void> {
    const now = this.d.ctx.clock.now();
    if (!force && now - this.lastUnlockPromptAt < UNLOCK_PROMPT_COOLDOWN) return;
    this.lastUnlockPromptAt = now;
    const token = this.d.gate.newPinToken('unlock');
    await this.d.chat.requestPin(token, '🔐 Unlock Operator Mode for today.');
  }

  private async onPin(token: string, pin: string): Promise<void> {
    const { gate, chat, approvals, session, runs } = this.d;
    const r = await gate.submitPin(token, pin);
    if (r.ok) {
      if (r.purpose === 'unlock') {
        this.lastUnlockPromptAt = 0;
        const queued = runs.queuedCount();
        await chat.say(queued ? '🔓 Unlocked for today. Working on it…' : '🔓 Unlocked for today.');
        session.ensure();
        void runs.drain();
      } else if (r.approvalId) {
        await approvals.onPinApproved(r.approvalId);
      }
      return;
    }
    switch (r.reason) {
      case 'wrong':
        await chat.say(`❌ Wrong PIN. ${r.remaining} ${r.remaining === 1 ? 'try' : 'tries'} left.`);
        if (r.purpose === 'unlock') await this.requestUnlock(true);
        else if (r.approvalId)
          await chat.requestPin(
            gate.newPinToken('approval', r.approvalId),
            '🔐 Enter your PIN to approve the critical action.',
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
        await chat.say('⌛ That PIN form has expired or was already used.');
        if (!gate.isUnlocked() && runs.queuedCount() > 0) await this.requestUnlock(true);
        return;
      case 'no_pin':
        await chat.say('🔐 No PIN is set yet. Set one at the PC first: wa-operator set-pin');
        return;
      case 'disabled':
        await chat.say('⏸️ Operator Mode is turned off at the PC.');
        return;
    }
  }

  private async onButton(id: string): Promise<void> {
    if (await this.d.approvals.onButton(id)) return;
    if (this.d.questions.onButton(id)) return;
    await this.d.chat.say('⌛ That button is no longer active.');
  }

  private async onCommand(text: string): Promise<void> {
    const { gate, chat, session, runs, governor } = this.d;
    const [cmd = '', arg = ''] = text.toLowerCase().split(/\s+/);
    switch (cmd) {
      case '/help':
        await chat.say(HELP, { format: false });
        return;
      case '/stop':
        if (!session.busy) {
          await chat.say('Nothing is running.');
          return;
        }
        await chat.say('⏹️ Stopping…');
        await session.interrupt();
        return;
      case '/kill': {
        session.kill();
        const dropped = runs.clearQueued();
        gate.lock('kill');
        audit(this.d.ctx, { actor: 'owner', action: 'command.kill', outcome: 'ok', metadata: { dropped } });
        await chat.say('🛑 Stopped everything and locked. Your next message will ask for the PIN.');
        return;
      }
      case '/lock':
        gate.lock('owner');
        await chat.say('🔒 Locked. Your next message will ask for the PIN.');
        return;
      case '/status': {
        const s = gate.state();
        const lines = [
          s.enabled ? (gate.isUnlocked() ? '🔓 Unlocked' : '🔒 Locked') : `⏸️ Off (${s.disabledReason ?? 'disabled'})`,
          session.busy ? '⚙️ Working on a task' : '💤 Idle',
          `📥 Queued: ${runs.queuedCount()}`,
          `🤝 Trusted mode: ${s.fullTrust ? 'full' : s.trusted ? 'on' : 'off'}`,
          `📊 Claude usage: ${governor.describe()}`,
        ];
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
      case '/new':
        if (session.busy) {
          await chat.say('A task is running. /stop it first.');
          return;
        }
        session.newSession();
        session.ensure();
        await chat.say('🆕 Fresh conversation started.');
        return;
      case '/trust':
        if (arg !== 'on' && arg !== 'off' && arg !== 'full') {
          await chat.say('Use /trust on, /trust full or /trust off.');
          return;
        }
        gate.setTrusted(arg === 'full' ? 'full' : arg === 'on');
        await chat.say(
          arg === 'full'
            ? '🤝 Full trust on: commands, scripts and file edits run without asking. Sending, deleting, installing, network commands and admin changes still ask, and so does anything after Claude reads an email or web page.'
            : arg === 'on'
              ? '🤝 Trusted mode on: file edits in work folders, sheet rows and Drive saves run without asking. Sends and commands still ask.'
              : '🤝 Trusted mode off: every change asks first.',
        );
        return;
      default:
        await chat.say(`Unknown command ${cmd}. Send /help for the list.`);
    }
  }
}
