import crypto from 'node:crypto';
import path from 'node:path';
import { and, eq, gt } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { AppContext } from '../context.js';
import type { Gate } from '../operator/gate.js';
import { proposedActions } from '../persistence/schema.js';
import { truncate } from '../security/redact.js';
import { errMsg } from '../shared/errors.js';
import { newId } from '../shared/ids.js';

/**
 * Approvals for tool calls. MEDIUM gets one tap, HIGH a card with the exact action (✅ / ✏️ / ❌),
 * CRITICAL a card plus the PIN, every time. Requests expire after OPERATOR_APPROVAL_TTL_SECONDS
 * (5 minutes); a stale button does nothing, and a decision is recorded once (atomic update).
 */

export type ApprovalTier = 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ApprovalRequest {
  runId: string | null;
  toolUseId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  tier: ApprovalTier;
  reason: string;
  /** The task's request, shown on the card when several tasks run at once. */
  task?: string;
  /** Offer a "remember" button (replaces ✏️ Edit) with this title, e.g. "✅ Always" or "✅ Today". */
  remember?: string;
}

export type ApprovalOutcome =
  | { decision: 'approved'; remember?: boolean }
  | { decision: 'rejected' }
  | { decision: 'expired' }
  | { decision: 'edit'; note: string }
  | { decision: 'failed'; error: string };

/** a = approve, r = cancel, e = edit, w = approve and remember. */
type ButtonKind = 'a' | 'r' | 'e' | 'w';

const BUTTON_RE = /^apv:(a|r|e|w):([0-9A-HJKMNP-TV-Z]{26})$/;

export function approvalButton(kind: ButtonKind, id: string): string {
  return `apv:${kind}:${id}`;
}

export function parseApprovalButton(id: string): { kind: ButtonKind; approvalId: string } | null {
  const m = BUTTON_RE.exec(id);
  return m ? { kind: m[1] as ButtonKind, approvalId: m[2]! } : null;
}

const s = (v: unknown, max = 700): string =>
  truncate(typeof v === 'string' ? v : JSON.stringify(v ?? '', null, 1), max);

/** What the owner sees on the card: the exact action, short enough for a phone. */
export function renderAction(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `Run command:\n${s(input.command)}`;
    case 'PowerShell':
      return `Run PowerShell:\n${s(input.command)}`;
    case 'Write':
      return `Write file ${s(input.file_path, 200)} (${String(input.content ?? '').length} characters)`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${s(input.file_path, 200)}\n− ${s(input.old_string, 250)}\n+ ${s(input.new_string, 250)}`;
    case 'NotebookEdit':
      return `Edit notebook ${s(input.notebook_path, 200)}`;
    case 'WebFetch':
      return `Open ${s(input.url, 300)}`;
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return `Read ${s(input.file_path ?? input.path ?? input.pattern, 300)}`;
  }
  if (toolName.startsWith('mcp__')) {
    const [, server, ...rest] = toolName.split('__');
    const keys = [
      'to',
      'recipient',
      'recipients',
      'cc',
      'bcc',
      'subject',
      'title',
      'summary',
      'body',
      'text',
      'message',
      'content',
      'url',
      'path',
      'spreadsheetId',
      'range',
      'values',
      'start',
      'end',
      'attendees',
      'amount',
      'query',
    ];
    const lines = keys
      .filter((k) => input[k] !== undefined && input[k] !== '')
      .map(
        (k) => `${k}: ${s(input[k], k === 'body' || k === 'text' || k === 'content' || k === 'message' ? 500 : 200)}`,
      );
    const body = lines.length ? lines.join('\n') : s(input, 600);
    return `${(server ?? '').replace(/^claude_ai_/, '')} → ${rest.join('__')}\n${body}`;
  }
  return `${toolName}\n${s(input, 600)}`;
}

/** Words only, never code: the card the owner reads on the phone. The exact input stays in renderAction (audit). */
export function plainAction(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const file = (v: unknown) => path.basename(str(v)) || 'a file';
  const site = (v: unknown) => {
    try {
      return new URL(str(v)).hostname.replace(/^www\./, '');
    } catch {
      return 'a web page';
    }
  };
  const human = (t: string) =>
    t
      .replace(/^browser_/, '')
      .replace(/[_-]+/g, ' ')
      .trim();
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const prog = path.basename(str(input.command).trim().split(/\s+/)[0] ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '');
      const what = str(input.description);
      return what
        ? `Run a command on the PC: ${truncate(what, 200)}`
        : `Run a command on the PC${prog ? ` (${prog})` : ''}`;
    }
    case 'Write':
      return `Create or overwrite the file "${file(input.file_path)}"`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Change the file "${file(input.file_path ?? input.notebook_path)}"`;
    case 'WebFetch':
      return `Open ${site(input.url)}`;
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return `Look at "${file(input.file_path ?? input.path)}"`;
  }
  if (!toolName.startsWith('mcp__')) return `Use ${human(toolName)}`;
  const [, rawServer, ...rest] = toolName.split('__');
  const server = (rawServer ?? '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  const tool = rest.join('__');
  const t = tool.toLowerCase();
  if (/^browser_|computer|playwright|chrome/.test(t) || /browser|chrome|playwright/i.test(server)) {
    if (/evaluate|javascript|script|run_code/.test(t)) return 'Read information from the open web page in the browser';
    if (/navigate|goto|open/.test(t)) return `Open ${site(input.url)} in the browser`;
    if (/click/.test(t))
      return `Click${str(input.element) ? ` "${truncate(str(input.element), 80)}"` : ' something'} in the browser`;
    if (/type|fill|form/.test(t))
      return `Type text into${str(input.element) ? ` "${truncate(str(input.element), 80)}"` : ' a field'} in the browser`;
    if (/upload/.test(t)) return 'Upload a file in the browser';
    if (/download/.test(t)) return 'Download a file in the browser';
    if (/screenshot|snapshot/.test(t)) return 'Look at the browser screen';
    if (/tab/.test(t)) return 'Switch or open a browser tab';
    return `Use the browser (${human(tool)})`;
  }
  const to = str(input.to) || str(input.recipient);
  const subject = str(input.subject) || str(input.title);
  const lines = [`${server}: ${human(tool)}`];
  if (to) lines.push(`To: ${truncate(to, 120)}`);
  if (subject) lines.push(`Subject: ${truncate(subject, 150)}`);
  const body = str(input.body) || str(input.text) || str(input.message);
  if (body && !/[{};]|=>|function\s*\(/.test(body)) lines.push(`"${truncate(body, 300)}"`);
  return lines.join('\n');
}

/** Tier reasons in plain words. */
export function plainReason(reason: string): string {
  if (/^new tool /.test(reason)) return 'first time using this tool';
  if (/^unknown tool/.test(reason)) return 'first time using this tool';
  if (/^change with /.test(reason)) return 'it changes something';
  if (/^browser /.test(reason)) return 'it acts in the browser';
  return reason.replace(/\(.*?wa-operator.*?\)/g, '').trim();
}

const HEADERS: Record<ApprovalTier, string> = {
  MEDIUM: '🟦 OK?',
  HIGH: '🟧 Approve?',
  CRITICAL: '🟥 Critical, may not be undoable.',
};

interface Waiter {
  resolve: (o: ApprovalOutcome) => void;
}

export class ApprovalEngine {
  private readonly waiters = new Map<string, Waiter>();
  /** Approval whose ✏️ Edit was tapped: the owner's next text is the correction. */
  private awaitingEdit: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly chat: OwnerChat,
    private readonly gate: Gate,
  ) {}

  get ttlMs(): number {
    return this.ctx.config.OPERATOR_APPROVAL_TTL_SECONDS * 1000;
  }

  pendingCount(): number {
    return this.waiters.size;
  }

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const id = newId();
    const now = this.ctx.clock.now();
    const preview = renderAction(req.toolName, req.input);
    const inputHash = crypto
      .createHash('sha256')
      .update(JSON.stringify([req.toolName, req.input]))
      .digest('hex');
    this.ctx.db
      .insert(proposedActions)
      .values({
        id,
        source: 'owner_tool',
        runId: req.runId,
        toolUseId: req.toolUseId,
        toolName: req.toolName,
        preview: truncate(preview, 2000),
        inputHash,
        tier: req.tier,
        reason: truncate(req.reason, 500),
        status: 'pending',
        needsPin: req.tier === 'CRITICAL',
        createdAt: now,
        expiresAt: now + this.ttlMs,
      })
      .run();
    audit(this.ctx, {
      actor: 'claude',
      action: 'approval.requested',
      target: id,
      outcome: req.tier,
      metadata: { tool: req.toolName, reason: req.reason, hash: inputHash.slice(0, 16) },
    });

    const outcome = new Promise<ApprovalOutcome>((resolve) => this.waiters.set(id, { resolve }));
    try {
      await this.sendCard(id, req);
    } catch (e) {
      this.finish(id, 'expired');
      this.waiters.delete(id);
      return { decision: 'failed', error: `could not reach the owner: ${errMsg(e)}` };
    }

    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => this.resolve(id, this.expire(id, 'cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, this.ttlMs);
    });
    const result = await Promise.race([outcome, timeout.then(() => this.expire(id, 'timeout'))]);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    this.waiters.delete(id);
    if (this.awaitingEdit === id) this.awaitingEdit = null;
    return result;
  }

  private async sendCard(id: string, req: ApprovalRequest): Promise<void> {
    const minutes = Math.round(this.ttlMs / 60_000);
    const task = req.task ? `📌 ${truncate(req.task.replace(/\s+/g, ' '), 60)}\n` : '';
    const body = `${HEADERS[req.tier]}\n${task}\n${plainAction(req.toolName, req.input)}\nWhy: ${plainReason(req.reason)}`;
    const footer = `${minutes} min · ${id.slice(-6)}`;
    let cardId: string | null;
    if (req.tier === 'CRITICAL') {
      cardId = await this.chat.buttons(body, [{ id: approvalButton('r', id), title: '❌ Cancel' }], { footer });
      const token = this.gate.newPinToken('approval', id);
      await this.chat.requestPin(token, `🔐 Enter your PIN to approve the critical action above (${id.slice(-6)}).`);
    } else {
      const buttons = [{ id: approvalButton('a', id), title: '✅ Approve' }];
      if (req.remember) buttons.push({ id: approvalButton('w', id), title: req.remember });
      else if (req.tier === 'HIGH') buttons.push({ id: approvalButton('e', id), title: '✏️ Edit' });
      buttons.push({ id: approvalButton('r', id), title: '❌ Cancel' });
      cardId = await this.chat.buttons(body, buttons, { footer });
    }
    if (cardId)
      this.ctx.db.update(proposedActions).set({ cardMessageId: cardId }).where(eq(proposedActions.id, id)).run();
  }

  /** Atomically move a pending, unexpired approval to its final state. Returns false if it was not open. */
  private finish(id: string, status: 'approved' | 'rejected' | 'expired' | 'edit', editNote?: string): boolean {
    const now = this.ctx.clock.now();
    const res = this.ctx.db
      .update(proposedActions)
      .set({ status, decidedAt: now, ...(editNote !== undefined ? { editNote: truncate(editNote, 1000) } : {}) })
      .where(
        and(
          eq(proposedActions.id, id),
          eq(proposedActions.status, 'pending'),
          ...(status === 'expired' ? [] : [gt(proposedActions.expiresAt, now)]),
        ),
      )
      .run();
    return res.changes === 1;
  }

  private expire(id: string, why: 'timeout' | 'cancelled'): ApprovalOutcome {
    if (this.finish(id, 'expired')) {
      audit(this.ctx, { actor: 'system', action: 'approval.expired', target: id, outcome: why });
      if (why === 'timeout')
        void this.chat.notify(
          `⌛ No answer within ${Math.round(this.ttlMs / 60_000)} min, so I skipped it (${id.slice(-6)}).`,
        );
    }
    return { decision: 'expired' };
  }

  private resolve(id: string, o: ApprovalOutcome): void {
    this.waiters.get(id)?.resolve(o);
  }

  /** The owner tapped an approval button. */
  async onButton(buttonId: string): Promise<boolean> {
    const b = parseApprovalButton(buttonId);
    if (!b) return false;
    const row = this.ctx.db.select().from(proposedActions).where(eq(proposedActions.id, b.approvalId)).get();
    const tag = b.approvalId.slice(-6);
    const open = row && row.status === 'pending' && row.expiresAt > this.ctx.clock.now() && this.waiters.has(row.id);
    if (!row || !open) {
      await this.chat.notify(`⌛ That request (${tag}) is no longer open. Nothing was done.`);
      return true;
    }
    if (b.kind === 'e') {
      if (row.tier !== 'HIGH') return true;
      this.awaitingEdit = row.id;
      await this.chat.notify(`✏️ What should change? Reply with the correction (${tag}).`);
      return true;
    }
    if (b.kind !== 'r' && row.needsPin) {
      await this.chat.notify(`🔐 This one needs your PIN (${tag}). Use the PIN form above.`);
      return true;
    }
    const status = b.kind === 'r' ? 'rejected' : 'approved';
    if (this.finish(row.id, status)) {
      const remember = b.kind === 'w';
      audit(this.ctx, {
        actor: 'owner',
        action: `approval.${status}`,
        target: row.id,
        outcome: remember ? 'remember' : 'ok',
      });
      this.resolve(row.id, status === 'approved' && remember ? { decision: status, remember } : { decision: status });
      if (status === 'rejected') await this.chat.notify(`❌ Cancelled (${tag}).`);
    } else {
      await this.chat.notify(`⌛ That request (${tag}) is no longer open. Nothing was done.`);
    }
    return true;
  }

  /** The PIN for a CRITICAL approval was verified by the gate. */
  async onPinApproved(approvalId: string): Promise<void> {
    if (this.waiters.has(approvalId) && this.finish(approvalId, 'approved')) {
      audit(this.ctx, { actor: 'owner', action: 'approval.approved', target: approvalId, outcome: 'pin' });
      this.resolve(approvalId, { decision: 'approved' });
    } else {
      await this.chat.notify(`⌛ That request (${approvalId.slice(-6)}) is no longer open. Nothing was done.`);
    }
  }

  /** If the owner is answering an ✏️ Edit, take their text as the correction. */
  takeEditNote(text: string): boolean {
    const id = this.awaitingEdit;
    if (!id) return false;
    this.awaitingEdit = null;
    if (!this.finish(id, 'edit', text)) return false;
    audit(this.ctx, { actor: 'owner', action: 'approval.edit', target: id, outcome: 'ok' });
    this.resolve(id, { decision: 'edit', note: text });
    return true;
  }

  /** On startup: nothing can still be waiting, so open requests expire (an approved action never re-runs). */
  recover(): number {
    const res = this.ctx.db
      .update(proposedActions)
      .set({ status: 'expired', decidedAt: this.ctx.clock.now() })
      .where(eq(proposedActions.status, 'pending'))
      .run();
    return res.changes;
  }
}
