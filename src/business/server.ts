import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { dayKey } from '../operator/gate.js';
import { errMsg } from '../shared/errors.js';
import {
  addLedger,
  addSchedule,
  closeMemory,
  deleteLedger,
  deleteRoutine,
  describeSchedule,
  duesByParty,
  ledgerReport,
  listLedger,
  listMemory,
  listRoutines,
  listSchedules,
  remember,
  removeSchedule,
  saveRoutine,
} from './store.js';

/**
 * The in-process MCP server `business`: memory, reminders and scheduled tasks, the sales/expense
 * ledger and saved routines. Every call still passes the PreToolUse gate (see tiers.ts).
 */

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const KINDS = ['sale', 'expense', 'purchase', 'due', 'due_paid'] as const;

export function createBusinessServer(ctx: AppContext) {
  const guard =
    <A>(action: string, fn: (args: A) => string) =>
    async (args: A) => {
      try {
        const text = fn(args);
        audit(ctx, { actor: 'claude', action: `business.${action}`, outcome: 'ok' });
        return ok(text);
      } catch (e) {
        return fail(`Not done: ${errMsg(e)}`);
      }
    };
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

  return createSdkMcpServer({
    name: 'business',
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'The business memory, reminders and scheduled tasks, the sales/expense ledger, and saved routines. All data stays encrypted on this PC.',
    tools: [
      // ---- memory
      tool(
        'memory_save',
        'Remember a lasting fact or preference about the business (fact), or an open task to carry to the next days (task). One short sentence each.',
        { kind: z.enum(['fact', 'task']), text: z.string().min(2).max(400) },
        guard('memory_save', (a) => `Saved [${remember(ctx, a.kind, a.text)}].`),
      ),
      tool(
        'memory_list',
        'List remembered facts and open tasks with their ids.',
        {},
        guard('memory_list', () => {
          const rows = listMemory(ctx);
          return rows.length
            ? rows.map((r) => `[${r.id}] (${r.kind}) ${r.text}`).join('\n')
            : 'Nothing remembered yet.';
        }),
      ),
      tool(
        'memory_done',
        'Forget a fact, or mark an open task as done, by id.',
        { id: z.string().min(1).max(40) },
        guard('memory_done', (a) => (closeMemory(ctx, a.id) ? `Done [${a.id}].` : `No open item [${a.id}].`)),
      ),
      // ---- schedules
      tool(
        'schedule_add',
        `Set a reminder (kind remind: the text is sent to them as is, at the time) or a scheduled task (kind task: you run the instruction at the time and send the result). Times are in the business time zone (${ctx.config.BUSINESS_TIMEZONE}). Repeat: once (on = YYYY-MM-DD), daily, weekly (on = days 0-6, Sunday = 0, e.g. "5" for Friday), monthly (on = day of month, 31 = last day). A task that runs while Operator Mode is locked can only read and report; changes then wait for them.`,
        {
          kind: z.enum(['remind', 'task']),
          title: z.string().min(1).max(80).describe('Short name, e.g. "Pay electricity bill"'),
          body: z.string().min(1).max(2000).describe('Reminder text, or the full instruction for the task'),
          repeat: z.enum(['once', 'daily', 'weekly', 'monthly']),
          time: z.string().describe('HH:MM, 24-hour'),
          on: z.string().optional(),
        },
        guard('schedule_add', (a) => {
          const s = addSchedule(ctx, { ...a, on: a.on ?? null });
          return `Scheduled: ${describeSchedule(ctx, s)}`;
        }),
      ),
      tool(
        'schedule_list',
        'List reminders and scheduled tasks with ids and next run time.',
        {},
        guard('schedule_list', () => {
          const rows = listSchedules(ctx);
          return rows.length ? rows.map((s) => describeSchedule(ctx, s)).join('\n') : 'No reminders or schedules.';
        }),
      ),
      tool(
        'schedule_remove',
        'Cancel a reminder or scheduled task by id.',
        { id: z.string().min(1).max(40) },
        guard('schedule_remove', (a) =>
          removeSchedule(ctx, a.id) ? `Cancelled [${a.id}].` : `No active schedule [${a.id}].`,
        ),
      ),
      // ---- ledger
      tool(
        'ledger_add',
        'Record sales, expenses, purchases (stock bought), dues (a customer owes the business) and due_paid (a customer paid back a due). One entry per line item. Amount in the local currency. Use source "photo" when read from a bill photo.',
        {
          entries: z
            .array(
              z.object({
                kind: z.enum(KINDS),
                amount: z.number().nonnegative(),
                party: z.string().max(80).optional().describe('Customer or supplier name'),
                item: z.string().max(120).optional(),
                qty: z.number().optional(),
                note: z.string().max(300).optional(),
                day: date.optional().describe('YYYY-MM-DD; today if left out'),
                source: z.enum(['text', 'photo', 'voice']).optional(),
              }),
            )
            .min(1)
            .max(50),
        },
        guard('ledger_add', (a) => {
          const ids = addLedger(ctx, a.entries);
          return `Recorded ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}: ${ids.map((id) => `[${id}]`).join(' ')}.`;
        }),
      ),
      tool(
        'ledger_report',
        'Totals for a date range: sales, expenses, purchases, net, dues given and collected, top items and a per-day breakdown.',
        { from: date, to: date },
        guard('ledger_report', (a) => {
          const r = ledgerReport(ctx, a.from, a.to);
          const t = r.totals;
          return [
            `${r.from} to ${r.to}`,
            `Sales ${fmt(t.sale)} · Expenses ${fmt(t.expense)} · Purchases ${fmt(t.purchase)} · Net ${fmt(r.net)}`,
            `Dues given ${fmt(t.due)} · Dues collected ${fmt(t.due_paid)}`,
            r.topItems.length
              ? `Top items: ${r.topItems.map((i) => `${i.item} ${fmt(i.amount)}${i.qty ? ` (${i.qty})` : ''}`).join(', ')}`
              : 'No item sales recorded.',
            r.byDay.length
              ? `By day:\n${r.byDay.map((d) => `${d.day}: sales ${fmt(d.sales)}, spent ${fmt(d.spent)}`).join('\n')}`
              : 'No entries.',
          ].join('\n');
        }),
      ),
      tool(
        'ledger_list',
        'List ledger entries (newest first, up to 200) with ids, filtered by date range, kind or party.',
        {
          from: date.optional(),
          to: date.optional(),
          kind: z.enum(KINDS).optional(),
          party: z.string().max(80).optional(),
        },
        guard('ledger_list', (a) => {
          const rows = listLedger(ctx, a);
          return rows.length
            ? rows
                .map(
                  (r) =>
                    `[${r.id}] ${r.day} ${r.kind} ${fmt(r.amount)}${r.item ? ` ${r.item}` : ''}${r.qty ? ` x${r.qty}` : ''}${r.party ? ` (${r.party})` : ''}${r.note ? ` – ${r.note}` : ''}`,
                )
                .join('\n')
            : 'No entries.';
        }),
      ),
      tool(
        'ledger_delete',
        'Remove a wrong ledger entry by id (to correct it, delete and add again).',
        { id: z.string().min(1).max(40) },
        guard('ledger_delete', (a) => (deleteLedger(ctx, a.id) ? `Removed [${a.id}].` : `No entry [${a.id}].`)),
      ),
      tool(
        'dues_list',
        'Who owes the business money right now, biggest first (all dues minus payments).',
        {},
        guard('dues_list', () => {
          const rows = duesByParty(ctx);
          if (!rows.length) return 'Nobody owes anything.';
          const total = rows.reduce((s, r) => s + r.owed, 0);
          return `${rows.map((r) => `${r.party}: ${fmt(r.owed)}`).join('\n')}\nTotal: ${fmt(total)}`;
        }),
      ),
      // ---- routines
      tool(
        'routine_save',
        'Save a routine: a short name for a longer instruction they can trigger later by name or from /menu.',
        { name: z.string().min(1).max(40), steps: z.string().min(1).max(2000) },
        guard('routine_save', (a) => `Saved routine "${saveRoutine(ctx, a.name, a.steps)}".`),
      ),
      tool(
        'routine_list',
        'List saved routines.',
        {},
        guard('routine_list', () => {
          const rows = listRoutines(ctx);
          return rows.length ? rows.map((r) => `"${r.name}": ${r.prompt}`).join('\n') : 'No routines saved.';
        }),
      ),
      tool(
        'routine_delete',
        'Delete a saved routine by name.',
        { name: z.string().min(1).max(40) },
        guard('routine_delete', (a) =>
          deleteRoutine(ctx, a.name) ? `Deleted "${a.name}".` : `No routine "${a.name}".`,
        ),
      ),
      tool(
        'today',
        'Today’s date and time in the business time zone.',
        {},
        guard('today', () => {
          const now = ctx.clock.now();
          const time = new Intl.DateTimeFormat('en-GB', {
            timeZone: ctx.config.BUSINESS_TIMEZONE,
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(new Date(now));
          return `${dayKey(now, ctx.config.BUSINESS_TIMEZONE)} ${time} (${ctx.config.BUSINESS_TIMEZONE})`;
        }),
      ),
    ],
  });
}
