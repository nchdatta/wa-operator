import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  query,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { eq, isNotNull } from 'drizzle-orm';
import type { ApprovalEngine } from '../approvals/engine.js';
import { audit } from '../audit.js';
import { createBusinessServer } from '../business/server.js';
import { memoryBrief } from '../business/store.js';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { AppContext } from '../context.js';
import { operatorSessions, toolTiers } from '../persistence/schema.js';
import type { Governor } from '../runtime/governor.js';
import { SECRET_NAMES } from '../security/secrets.js';
import { truncate } from '../security/redact.js';
import { errMsg } from '../shared/errors.js';
import { dayKey, type Gate } from './gate.js';
import type { OwnerQuestions } from './output.js';
import { createWhatsAppOutServer } from './output.js';
import { DENY_NAMES, defaultDenyPaths, realPath, type PathPolicy } from './paths.js';
import { operatorRules } from './scope.js';
import { TaintTracker } from './taint.js';
import { isTier, type Tier } from './tier.js';
import { classify, stillAsksInFullTrust, suggestMcpTier, type Classification } from './tiers.js';

/**
 * One warm Claude Agent SDK session per day on the owner's Claude subscription. Owner messages are
 * streamed in as they arrive; every tool call passes the PreToolUse gate below before it runs.
 */

/** Backstop to the gate: denied in every mode, even if the hook were bypassed. */
export const HARD_DENY = [
  'AskUserQuestion',
  'Read(**/.env)',
  'Read(**/.env.*)',
  'Edit(**/.env)',
  'Edit(**/.env.*)',
  'Write(**/.env)',
  'Write(**/.env.*)',
  'Read(~/.ssh/**)',
  'Edit(~/.ssh/**)',
  'Write(~/.ssh/**)',
  'Bash(rm -rf /)',
  'Bash(rm -rf /*)',
  'Bash(rm -rf ~)',
  'Bash(rm -rf ~/*)',
  'Bash(format:*)',
  'Bash(diskpart:*)',
  'PowerShell(Format-Volume:*)',
  'PowerShell(Clear-Disk:*)',
];

export interface RunHandle {
  id: string;
  prompt: string;
  sourceMessageId: string | null;
  /** schedule: started by a saved schedule. While locked it may only use LOW-tier tools. */
  origin?: 'owner' | 'schedule';
}

export interface RunResult {
  ok: boolean;
  text: string;
  stopped: boolean;
  toolCalls: number;
  tainted: boolean;
}

interface ActiveRun extends RunHandle {
  taint: TaintTracker;
  toolCalls: number;
  startedAt: number;
  lastProgressAt: number;
  pendingResults: number;
  texts: string[];
  /** Last progress line sent, so the same step is not repeated. */
  lastProgressLabel: string;
  /** Owner-confirmed MCP tiers, read once per task. */
  overrides: Map<string, Tier>;
  stopped: boolean;
  done: (r: RunResult) => void;
}

/** Minimal async queue used as the session's streaming input. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: m, done: false });
    } else this.items.push(m);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  } as SDKUserMessage;
}

/** claude_desktop_config.json for the classic installer and the Microsoft Store (MSIX) build. */
export function desktopConfigPaths(): string[] {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const out = [path.join(appData, 'Claude', 'claude_desktop_config.json')];
  try {
    for (const d of fs.readdirSync(path.join(local, 'Packages')))
      if (/^Claude_/i.test(d))
        out.push(path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  } catch {
    // no Store apps folder
  }
  return out.filter((f) => fs.existsSync(f));
}

function readMcpFile(file: string): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * Claude Desktop's local MCP servers (read live, so a server added in Desktop shows up after a restart) plus
 * config/mcp.json, which wins on a name clash. Claude Code's own servers, plugins, skills and claude.ai
 * connectors come in through settingSources ['user'].
 */
export function loadImportedMcp(ctx: AppContext): { servers: Record<string, McpServerConfig>; skipped: string[] } {
  const desktop = Object.assign({}, ...desktopConfigPaths().map(readMcpFile)) as Record<string, McpServerConfig>;
  const all = { ...desktop, ...readMcpFile(path.join(ctx.config.appDir, 'config', 'mcp.json')) };
  const allow = ctx.config.OPERATOR_MCP_ALLOW.map((s) => s.toLowerCase());
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  for (const [name, cfg] of Object.entries(all)) {
    if (allow.length && !allow.includes(name.toLowerCase())) continue;
    const missing = missingFile(cfg);
    if (missing) {
      skipped.push(`${name} (missing ${missing})`);
      continue;
    }
    servers[name] = cfg;
  }
  return { servers, skipped };
}

/** A stdio server whose command or script path no longer exists (e.g. a moved project). */
export function missingFile(cfg: McpServerConfig): string | null {
  if (!('command' in cfg) || typeof cfg.command !== 'string') return null;
  const args = ('args' in cfg && Array.isArray(cfg.args) ? cfg.args : []) as string[];
  const candidates = [cfg.command, ...args.filter((a) => /\.(c|m)?js$|\.py$|\.exe$/i.test(a))];
  for (const p of candidates) if (path.isAbsolute(p) && !fs.existsSync(p)) return p;
  return null;
}

export function buildPathPolicy(ctx: AppContext): PathPolicy {
  const c = ctx.config;
  return {
    roots: [...c.roots, c.inbox, c.outbox].map((r) => realPath(r, c.home)),
    denyPaths: defaultDenyPaths(c.appDir, c.dataDir, c.OPERATOR_EXTRA_DENY),
    denyNames: DENY_NAMES,
  };
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const base = (v: unknown) => (typeof v === 'string' ? path.basename(v) : '');
  switch (name) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Write':
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Glob':
    case 'Grep':
      return 'Searching files';
    case 'Bash':
    case 'PowerShell':
      return 'Running a command';
    case 'WebFetch':
      try {
        return `Opening ${new URL(String(input.url)).hostname}`;
      } catch {
        return 'Opening a web page';
      }
    case 'WebSearch':
      return 'Searching the web';
    case 'Agent':
    case 'Task':
      return 'Working on a sub-task';
  }
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `Using ${(server ?? '').replace(/^claude_ai_/, '')} (${(tool ?? '').replace(/_/g, ' ')})`;
  }
  return 'Working';
}

/** Rough effort pick: multi-step requests get more thinking. */
export function pickEffort(prompt: string): 'medium' | 'high' {
  return prompt.length > 280 ||
    /\b(then|and then|after that|every|all|each|report|compare|analy[sz]e|fix|set up)\b/i.test(prompt)
    ? 'high'
    : 'medium';
}

/** Short, simple requests go to the fast model; multi-step ones to the main model. */
export function pickModel(prompt: string, main: string, fast: string): string {
  return fast === 'off' || pickEffort(prompt) === 'high' ? main : fast;
}

export interface SessionInfo {
  model: string | null;
  startedAt: number | null;
  failedServers: string[];
}

export class OperatorSession {
  private q: Query | null = null;
  private inbox: Inbox | null = null;
  private day: string | null = null;
  private run: ActiveRun | null = null;
  private readonly allowedToolUses = new Set<string>();
  /** Commands the owner tapped "✅ Today" for (tool + first two words), until the session ends. */
  private readonly rememberedCommands = new Set<string>();
  private failedServers: string[] = [];
  private startedAt: number | null = null;
  private model: string | null = null;
  private lastRunEndedAt = 0;
  private readonly policy: PathPolicy;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly chat: OwnerChat,
    private readonly gate: Gate,
    private readonly approvals: ApprovalEngine,
    private readonly governor: Governor,
    private readonly questions: OwnerQuestions,
  ) {
    this.policy = buildPathPolicy(ctx);
  }

  get busy(): boolean {
    return this.run !== null;
  }

  get currentRunId(): string | null {
    return this.run?.id ?? null;
  }

  info(): SessionInfo {
    return { model: this.model, startedAt: this.startedAt, failedServers: this.failedServers };
  }

  /** Start (or keep) today's warm session. A new day starts a fresh session. */
  ensure(): void {
    const today = dayKey(this.ctx.clock.now(), this.ctx.config.BUSINESS_TIMEZONE);
    if (this.q && this.day === today) return;
    if (this.q && this.run) return; // never cut a running task at midnight
    this.close();
    const saved = this.ctx.db.select().from(operatorSessions).where(eq(operatorSessions.day, today)).get();
    const resume = saved && !saved.closedAt ? saved.sessionId : undefined;
    this.day = today;
    this.startedAt = this.ctx.clock.now();
    this.model = this.ctx.config.OPERATOR_MODEL;
    this.inbox = new Inbox();
    this.q = query({ prompt: this.inbox, options: this.options(resume) });
    const q = this.q;
    this.loop = this.consume(q).finally(() => {
      if (this.q === q) {
        this.q = null;
        this.inbox = null;
      }
    });
    this.ctx.logger.info({ day: today, resume: !!resume }, 'operator session started');
  }

  private options(resume: string | undefined): Options {
    const c = this.ctx.config;
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of [...SECRET_NAMES, 'OPERATOR_PIN_HASH']) delete env[k];
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'wa-operator/0.1.0';
    // Right after boot, npx-based MCP servers can take longer than Claude Code's 30 s default.
    env.MCP_TIMEOUT ??= '60000';
    if (c.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = c.CLAUDE_CODE_OAUTH_TOKEN;

    const gateHook: HookCallback = (input, toolUseID, { signal }) => this.gateHook(input, toolUseID, signal);
    const imported = loadImportedMcp(this.ctx);
    this.failedServers = imported.skipped;
    if (imported.skipped.length) this.ctx.logger.warn({ skipped: imported.skipped }, 'MCP servers skipped');
    return {
      model: c.OPERATOR_MODEL,
      cwd: c.home,
      additionalDirectories: [...c.roots, c.inbox, c.outbox].filter((r) => r !== c.home),
      settingSources: ['user'],
      mcpServers: {
        ...imported.servers,
        'whatsapp-out': createWhatsAppOutServer(this.ctx, this.chat, this.questions),
        business: createBusinessServer(this.ctx),
      },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `${operatorRules(c)}

${memoryBrief(this.ctx)}`,
      },
      disallowedTools: HARD_DENY,
      permissionMode: 'default',
      // Every call is decided by the hook; anything that still falls through to a prompt is denied
      // unless the hook already approved that exact call.
      canUseTool: async (_name, _input, opts): Promise<PermissionResult> =>
        this.allowedToolUses.has(opts.toolUseID)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'Not approved by Operator Mode.' },
      hooks: {
        // The hook waits for the owner's tap: allow a little more than the approval TTL.
        PreToolUse: [{ hooks: [gateHook], timeout: c.OPERATOR_APPROVAL_TTL_SECONDS + 15 }],
      },
      ...(c.OPERATOR_BROWSER ? { extraArgs: { chrome: null } } : {}),
      maxTurns: c.OPERATOR_MAX_TURNS,
      effort: 'medium',
      env,
      stderr: (data: string) => this.ctx.logger.debug({ stderr: truncate(data, 500) }, 'claude stderr'),
      ...(resume ? { resume } : {}),
    };
  }

  private loadOverrides(): Map<string, Tier> {
    const rows = this.ctx.db.select().from(toolTiers).where(isNotNull(toolTiers.tier)).all();
    return new Map(rows.filter((r) => r.tier && isTier(r.tier)).map((r) => [r.toolName, r.tier as Tier]));
  }

  private recordSeenTool(toolName: string): void {
    const now = this.ctx.clock.now();
    this.ctx.db
      .insert(toolTiers)
      .values({ toolName, tier: null, suggested: suggestMcpTier(toolName), firstSeenAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
  }

  private async gateHook(input: Parameters<HookCallback>[0], toolUseID: string | undefined, signal: AbortSignal) {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decide = (decision: 'allow' | 'deny', reason: string) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    });
    const run = this.run;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const toolName = input.tool_name;

    if (!this.gate.state().enabled || !run || run.stopped)
      return decide('deny', 'Operator Mode is locked or the task was stopped.');
    run.toolCalls++;
    if (run.toolCalls > this.ctx.config.OPERATOR_MAX_TURNS * 3) {
      void this.interrupt();
      return decide('deny', 'Too many steps for one task; stopping.');
    }
    this.gate.touch();

    const c = classify(toolName, toolInput, input.cwd || this.ctx.config.home, {
      policy: this.policy,
      tainted: run.taint.tainted,
      knownDomains: run.taint.knownDomains,
      overrides: run.overrides,
      untrustedDirs: [this.ctx.config.inbox, path.join(process.env.USERPROFILE ?? '', 'Downloads')],
    });
    if (c.unconfirmed) this.recordSeenTool(toolName);
    const meta = { tool: toolName, tier: c.tier, reason: c.reason, run: run.id, tainted: run.taint.tainted };

    // A scheduled task while locked: reading and reporting only, nobody is there to approve.
    if (run.origin === 'schedule' && !this.gate.isUnlocked() && c.tier !== 'LOW') {
      audit(this.ctx, { actor: 'claude', action: 'tool.denied', outcome: 'locked_schedule', metadata: meta });
      return decide(
        'deny',
        'Operator Mode is locked, so this scheduled task can only read and report. Do not try another way: finish the report and tell them in one line what still needs doing after they unlock.',
      );
    }
    let allowed = false;
    let reason = c.reason;
    const g = this.gate.state();
    const fullTrustAllows = g.fullTrust && c.tier === 'HIGH' && !run.taint.tainted && !stillAsksInFullTrust(c);
    const memo = this.memoKey(toolName, toolInput, c, run.taint.tainted);
    if (c.tier === 'LOW' || (c.tier === 'MEDIUM' && g.trusted) || fullTrustAllows) {
      allowed = true;
    } else if (memo?.kind === 'command' && this.rememberedCommands.has(memo.key)) {
      allowed = true;
      reason = 'They allowed this command for today.';
    } else if (c.tier === 'DENY') {
      audit(this.ctx, { actor: 'claude', action: 'tool.denied', outcome: 'DENY', metadata: meta });
      await this.chat.notify(
        `🚫 Blocked: ${describeTool(toolName, toolInput).toLowerCase()} (${c.reason.split('; ').find((r) => /secret|dump|blocked|.env|credential/.test(r)) ?? c.reason.split('; ')[0]}).`,
      );
      return decide('deny', `Blocked by Operator Mode: ${c.reason}. This cannot be approved; do not try another way.`);
    } else {
      this.progressPause = true;
      const outcome = await this.approvals.request(
        {
          runId: run.id,
          toolUseId: toolUseID ?? null,
          toolName,
          input: toolInput,
          tier: c.tier,
          reason: c.reason,
          ...(memo ? { remember: memo.kind === 'tool' ? '✅ Always' : '✅ Today' } : {}),
        },
        signal,
      );
      this.progressPause = false;
      run.lastProgressAt = this.ctx.clock.now();
      switch (outcome.decision) {
        case 'approved':
          allowed = true;
          reason = 'They approved it.';
          if (outcome.remember && memo) this.remember(memo, toolName, run);
          break;
        case 'edit':
          return decide('deny', `They want a change before this runs: "${outcome.note}". Apply it and try again.`);
        case 'rejected':
          return decide(
            'deny',
            'They tapped Cancel, so this was not done. Do not try to do it another way. Acknowledge it in a few words, speaking to them as "you" (e.g. "OK, I didn\'t send it.").',
          );
        case 'expired':
          return decide(
            'deny',
            `They didn't tap Approve within ${Math.round(this.ctx.config.OPERATOR_APPROVAL_TTL_SECONDS / 60)} minutes, so this was not done. Tell them briefly, as "you".`,
          );
        case 'failed':
          return decide('deny', `Approval could not be requested (${outcome.error}).`);
      }
    }
    if (!allowed) return decide('deny', reason);
    run.taint.record({ toolName, taints: c.taints, domain: c.domain });
    if (toolUseID) this.allowedToolUses.add(toolUseID);
    audit(this.ctx, { actor: 'claude', action: 'tool.allowed', outcome: c.tier, metadata: meta });
    return decide('allow', reason);
  }

  private progressPause = false;

  /**
   * What "remember" would cover for this call, if anything: an unconfirmed MCP tool with no risk flag
   * (saved as always allowed), or a plain risk-free command (allowed until the session ends).
   */
  private memoKey(
    toolName: string,
    input: Record<string, unknown>,
    c: Classification,
    tainted: boolean,
  ): { kind: 'tool' | 'command'; key: string } | null {
    if (tainted || (c.risks?.length ?? 0) > 0 || (c.tier !== 'HIGH' && c.tier !== 'MEDIUM')) return null;
    if (c.unconfirmed) return c.unconfirmed.suggested === 'CRITICAL' ? null : { kind: 'tool', key: toolName };
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const cmd = typeof input.command === 'string' ? input.command.trim() : '';
      if (!cmd || /[;&|`$<>\n]/.test(cmd)) return null;
      return { kind: 'command', key: `${toolName}:${cmd.toLowerCase().split(/\s+/).slice(0, 2).join(' ')}` };
    }
    return null;
  }

  private remember(memo: { kind: 'tool' | 'command'; key: string }, toolName: string, run: ActiveRun): void {
    if (memo.kind === 'command') {
      this.rememberedCommands.add(memo.key);
      return;
    }
    const now = this.ctx.clock.now();
    this.ctx.db
      .insert(toolTiers)
      .values({ toolName, tier: 'LOW', suggested: suggestMcpTier(toolName), firstSeenAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: toolTiers.toolName, set: { tier: 'LOW', updatedAt: now } })
      .run();
    run.overrides.set(toolName, 'LOW');
    audit(this.ctx, { actor: 'owner', action: 'tool.always_allow', target: toolName, outcome: 'LOW' });
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) await this.handle(msg);
    } catch (e) {
      this.ctx.logger.error({ err: errMsg(e) }, 'operator session ended with an error');
      this.finishRun({ ok: false, text: `⚠️ Claude stopped unexpectedly: ${truncate(errMsg(e), 300)}` });
    }
    // The process ended: any open run cannot finish.
    this.finishRun({ ok: false, text: '⚠️ The Claude session ended. Send your message again.' });
  }

  private async handle(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.storeSession(msg.session_id);
          for (const t of msg.tools)
            if (t.startsWith('mcp__') && !/^mcp__(whatsapp-out|business)__/.test(t)) this.recordSeenTool(t);
          const failed = msg.mcp_servers.filter((s) => s.status !== 'connected' && s.status !== 'pending');
          this.failedServers = [
            ...this.failedServers.filter((s) => s.includes('(missing')),
            ...failed.map((s) => `${s.name} (${s.status})`),
          ];
          if (failed.length) this.ctx.logger.warn({ servers: failed }, 'some MCP servers did not connect');
        }
        return;
      case 'assistant': {
        const run = this.run;
        if (!run) return;
        const content = msg.message.content as { type: string; name?: string; input?: unknown }[];
        const tool = content.find((b) => b.type === 'tool_use');
        if (!tool) return;
        const now = this.ctx.clock.now();
        const every = this.ctx.config.OPERATOR_PROGRESS_SECONDS * 1000;
        const label = describeTool(tool.name ?? '', (tool.input ?? {}) as Record<string, unknown>);
        // Only report a new kind of step, at most once per interval.
        if (
          !this.progressPause &&
          label !== run.lastProgressLabel &&
          now - run.startedAt > 15_000 &&
          now - run.lastProgressAt >= every
        ) {
          run.lastProgressAt = now;
          run.lastProgressLabel = label;
          await this.chat.notify(`⏳ ${label}…`);
        }
        return;
      }
      case 'rate_limit_event':
        await this.governor.update(msg.rate_limit_info);
        return;
      case 'result': {
        const run = this.run;
        if (!run) return;
        const text = msg.subtype === 'success' ? msg.result : '';
        if (text.trim()) run.texts.push(text);
        run.pendingResults--;
        const more = msg.queued_turn_count ?? Math.max(run.pendingResults, 0);
        if (more > 0) return;
        const ok = msg.subtype === 'success' && !msg.is_error;
        const failText =
          msg.subtype === 'error_max_turns'
            ? '⚠️ That took too many steps, so I stopped. Try a smaller request.'
            : msg.subtype === 'success'
              ? ''
              : '⚠️ Something went wrong while working on that.';
        this.finishRun({ ok, text: run.texts.join('\n\n') || failText || (run.stopped ? '⏹️ Stopped.' : '✅ Done.') });
        return;
      }
      default:
        return;
    }
  }

  private storeSession(sessionId: string): void {
    if (!this.day) return;
    const now = this.ctx.clock.now();
    this.ctx.db
      .insert(operatorSessions)
      .values({ day: this.day, sessionId, createdAt: now })
      .onConflictDoUpdate({ target: operatorSessions.day, set: { sessionId, closedAt: null } })
      .run();
  }

  private finishRun(r: { ok: boolean; text: string }): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.lastRunEndedAt = this.ctx.clock.now();
    this.allowedToolUses.clear();
    this.questions.cancel();
    run.done({ ...r, stopped: run.stopped, toolCalls: run.toolCalls, tainted: run.taint.tainted });
  }

  /** Run one owner instruction to completion (the caller guarantees one at a time). */
  async runTask(handle: RunHandle): Promise<RunResult> {
    if (this.run) throw new Error('a task is already running');
    const now = this.ctx.clock.now();
    const freshMs = this.ctx.config.OPERATOR_FRESH_AFTER_MIN * 60_000;
    // A long gap since the last task: start a fresh conversation so old context doesn't slow every turn.
    if (this.q && freshMs > 0 && this.lastRunEndedAt > 0 && now - this.lastRunEndedAt > freshMs) {
      this.ctx.logger.info('idle gap: starting a fresh conversation');
      this.newSession();
    }
    this.ensure();
    const q = this.q!;
    const result = new Promise<RunResult>((done) => {
      this.run = {
        ...handle,
        taint: new TaintTracker(handle.prompt),
        toolCalls: 0,
        startedAt: now,
        lastProgressAt: now,
        pendingResults: 1,
        texts: [],
        lastProgressLabel: '',
        overrides: this.loadOverrides(),
        stopped: false,
        done,
      };
    });
    try {
      await q.applyFlagSettings({ effortLevel: pickEffort(handle.prompt) });
    } catch (e) {
      this.ctx.logger.debug({ err: errMsg(e) }, 'could not set effort');
    }
    const model = pickModel(handle.prompt, this.ctx.config.OPERATOR_MODEL, this.ctx.config.OPERATOR_FAST_MODEL);
    if (model !== this.model) {
      try {
        await q.setModel(model);
        this.model = model;
      } catch (e) {
        this.ctx.logger.debug({ err: errMsg(e) }, 'could not switch model');
      }
    }
    this.inbox!.push(userMessage(handle.prompt));
    return result;
  }

  /** The owner replied to the running task: feed it in as part of the same task. */
  addToRun(text: string): boolean {
    if (!this.run || !this.inbox) return false;
    this.run.taint.addOwnerText(text);
    this.run.pendingResults++;
    this.inbox.push(userMessage(text));
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.run) this.run.stopped = true;
    this.questions.cancel();
    try {
      await this.q?.interrupt();
    } catch (e) {
      this.ctx.logger.warn({ err: errMsg(e) }, 'interrupt failed');
    }
  }

  /** Hard stop for /kill: end the process so nothing keeps running. */
  kill(): void {
    if (this.run) this.run.stopped = true;
    this.finishRun({ ok: false, text: '⏹️ Killed.' });
    this.close();
  }

  /** /new: forget today's conversation and start fresh. */
  newSession(): void {
    if (this.day)
      this.ctx.db
        .update(operatorSessions)
        .set({ closedAt: this.ctx.clock.now() })
        .where(eq(operatorSessions.day, this.day))
        .run();
    this.close();
  }

  close(): void {
    this.inbox?.close();
    try {
      this.q?.close();
    } catch {
      // already gone
    }
    this.q = null;
    this.inbox = null;
    this.day = null;
    this.startedAt = null;
    this.allowedToolUses.clear();
    this.rememberedCommands.clear();
  }

  async shutdown(): Promise<void> {
    this.close();
    await this.loop?.catch(() => undefined);
  }
}
