import fs from 'node:fs';
import { checkPath, type PathPolicy, type PathVerdict } from './paths.js';
import { analyzeShell, type RiskFlag } from './shell.js';
import { bump, maxTier, type Tier } from './tier.js';

/**
 * Sorts every tool call (built-in or MCP) into LOW, MEDIUM, HIGH, CRITICAL or DENY.
 *
 * LOW       reads, search, screenshots, browsing                → runs, logged
 * MEDIUM    file edits in work folders, sheet rows, Drive saves   → runs in trusted mode, otherwise one tap
 * HIGH      sends, commands, installs, invites, unknown tools     → card with the exact action
 * CRITICAL  deletes outside work folders, payments, registry…     → button and PIN, every time
 * DENY      secrets, browser profiles, this app's own files      → always blocked
 */

export interface TierContext {
  policy: PathPolicy;
  /** The task has read outside content (web page, email, downloaded file). */
  tainted: boolean;
  /** Domains the owner named or the task visited before it was tainted. */
  knownDomains: ReadonlySet<string>;
  /** Owner-confirmed tiers for MCP tools (wa-operator tiers). */
  overrides: ReadonlyMap<string, Tier>;
  /** Folders whose files count as outside content (inbox, Downloads). */
  untrustedDirs: string[];
}

export interface Classification {
  tier: Tier;
  reason: string;
  /** Reading this marks the task tainted. */
  taints: boolean;
  /** Leaves the PC (email, message, upload, network command). */
  sends: boolean;
  /** Website this call visits, if any. */
  domain?: string;
  /** Structured risks: full trust and "always allow" decide on these, never on the reason text. */
  risks?: RiskFlag[];
  /** Set for an MCP tool the owner has not confirmed yet, with the suggested tier. */
  unconfirmed?: { suggested: Tier };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** Domains mentioned in the owner's own message are fine to visit even after taint. */
export function domainsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?/gi)) {
    const d = domainOf(m[1]!.startsWith('http') ? m[1]! : `https://${m[1]}`);
    if (d) out.add(d);
  }
  return [...out];
}

/** Windows marks downloaded files with a Zone.Identifier stream (Mark of the Web). */
export function fromInternet(real: string): boolean {
  if (process.platform !== 'win32' || !real) return false;
  try {
    return /ZoneId=[34]/.test(fs.readFileSync(`${real}:Zone.Identifier`, 'utf8'));
  } catch {
    return false;
  }
}

function pathTier(verdict: PathVerdict, inside: Tier, outside: Tier): Tier {
  return verdict === 'deny' ? 'DENY' : verdict === 'inside' ? inside : outside;
}

export function classify(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  ctx: TierContext,
): Classification {
  const base = classifyRaw(toolName, input, cwd, ctx);
  let { tier } = base;
  let reason = base.reason;
  // Taint: after outside content was read, anything that leaves the PC moves up one tier.
  if (ctx.tainted && tier !== 'DENY') {
    if (base.sends) {
      tier = bump(tier);
      reason += ' (after reading outside content)';
    } else if (base.domain && !isKnownDomain(base.domain, ctx.knownDomains)) {
      tier = bump(tier);
      reason += ` (new website ${base.domain} after reading outside content)`;
    }
  }
  return { ...base, tier, reason };
}

function isKnownDomain(d: string, known: ReadonlySet<string>): boolean {
  for (const k of known) if (d === k || d.endsWith(`.${k}`)) return true;
  return false;
}

function classifyRaw(toolName: string, input: Record<string, unknown>, cwd: string, ctx: TierContext): Classification {
  const p = ctx.policy;
  const none = { taints: false, sends: false };
  const untrusted = (real: string) => ctx.untrustedDirs.some((d) => real.toLowerCase().startsWith(d.toLowerCase()));

  switch (toolName) {
    case 'Read':
    case 'NotebookRead':
    case 'LS':
    case 'Glob':
    case 'Grep': {
      const target = str(input.file_path) || str(input.notebook_path) || str(input.path) || cwd;
      const { verdict, real } = checkPath(target, cwd, p);
      // A glob pattern can name a blocked file too (e.g. "**/.env").
      const pattern = str(input.pattern) || str(input.glob);
      const patternDenied = /(^|[\\/*])\.env\b|id_rsa|\.pem$|credentials/i.test(pattern) && toolName === 'Glob';
      const tier = patternDenied ? 'DENY' : pathTier(verdict, 'LOW', 'MEDIUM');
      return {
        tier,
        reason:
          tier === 'DENY'
            ? 'blocked path'
            : verdict === 'inside'
              ? 'read in work folders'
              : 'read outside work folders',
        taints: toolName === 'Read' && (untrusted(real) || fromInternet(real)),
        sends: false,
      };
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const target = str(input.file_path) || str(input.notebook_path);
      const { verdict } = checkPath(target, cwd, p);
      const tier = pathTier(verdict, 'MEDIUM', 'HIGH');
      return {
        tier,
        ...(verdict === 'outside' ? { risks: ['outside' as const] } : {}),
        reason:
          tier === 'DENY'
            ? 'blocked path'
            : verdict === 'inside'
              ? 'edit in work folders'
              : 'edit outside work folders',
        ...none,
      };
    }
    case 'Bash':
    case 'PowerShell':
    case 'Monitor': {
      const flavor = toolName === 'PowerShell' ? 'powershell' : 'bash';
      const a = analyzeShell(str(input.command), flavor, cwd, p);
      return {
        tier: maxTier(a.tier),
        reason: a.reasons.join('; '),
        taints: a.network,
        sends: a.network,
        risks: a.risks,
      };
    }
    case 'WebFetch': {
      const domain = domainOf(str(input.url));
      return { tier: 'LOW', reason: 'read a web page', taints: true, sends: false, ...(domain ? { domain } : {}) };
    }
    case 'WebSearch':
      return { tier: 'LOW', reason: 'web search', taints: true, sends: false };
    case 'AskUserQuestion':
      return { tier: 'DENY', reason: 'no dialog here: use the ask_owner tool to ask on WhatsApp', ...none };
    case 'CronCreate':
    case 'CronDelete':
    case 'RemoteTrigger':
    case 'ScheduleWakeup':
      return { tier: 'HIGH', reason: 'schedules work', risks: ['schedules'], ...none };
    case 'Task':
    case 'Agent':
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'TaskOutput':
    case 'TaskStop':
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
    case 'ToolSearch':
    case 'Skill':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
    case 'SendUserMessage':
      return { tier: 'LOW', reason: 'internal', ...none };
  }

  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, input, cwd, ctx);
  return { tier: 'HIGH', reason: `unknown tool ${toolName}`, ...none };
}

// ---- MCP tools ------------------------------------------------------------------------------------

const OWN_SERVER = 'mcp__whatsapp-out__';

function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const CRIT_WORDS = [
  'pay',
  'payment',
  'transfer',
  'refund',
  'charge',
  'purchase',
  'buy',
  'withdraw',
  'bulk',
  'broadcast',
  'wipe',
  'purge',
];
const SEND_WORDS = [
  'send',
  'reply',
  'forward',
  'post',
  'publish',
  'invite',
  'share',
  'tweet',
  'notify',
  'submit',
  'respond',
];
const DELETE_WORDS = ['delete', 'remove', 'trash', 'destroy', 'drop', 'revoke', 'cancel', 'archive', 'unsubscribe'];
const WRITE_WORDS = [
  'create',
  'update',
  'add',
  'append',
  'write',
  'edit',
  'insert',
  'upload',
  'save',
  'move',
  'rename',
  'label',
  'modify',
  'set',
  'copy',
  'draft',
  'patch',
  'put',
  'apply',
  'mark',
  'click',
  'type',
  'fill',
  'form',
  'input',
  'press',
  'drag',
  'upsert',
  'import',
];
const READ_WORDS = [
  'get',
  'list',
  'read',
  'search',
  'find',
  'query',
  'fetch',
  'view',
  'describe',
  'show',
  'download',
  'export',
  'count',
  'lookup',
  'status',
  'info',
  'screenshot',
  'snapshot',
  'context',
  'tabs',
  'page',
  'text',
  'navigate',
  'open',
  'scroll',
  'wait',
  'console',
  'network',
  'resolve',
  'inspect',
  'check',
  'guide',
];
const TAINT_HINT = /gmail|mail|inbox|outlook|browser|chrome|web|fetch|scrape|page|drive|docs|slack|message|thread/i;

/** Tier an MCP tool would get from its name alone; the owner confirms it once. */
export function suggestMcpTier(toolName: string): Tier {
  const w = words(toolName.split('__').slice(2).join('_') || toolName);
  const has = (list: string[]) => w.some((x) => list.includes(x));
  // The leading verb decides first: get_message is a read, send_message a send.
  const verb = w[0] ?? '';
  if (READ_WORDS.includes(verb) && verb !== 'navigate' && verb !== 'open') return 'LOW';
  if (SEND_WORDS.includes(verb)) return 'HIGH';
  if (CRIT_WORDS.includes(verb)) return 'CRITICAL';
  if (DELETE_WORDS.includes(verb)) return 'HIGH';
  if (WRITE_WORDS.includes(verb) || ['unlabel', 'unmark', 'untrash'].includes(verb)) return 'MEDIUM';
  if (
    w.includes('javascript') ||
    w.includes('eval') ||
    w.includes('exec') ||
    w.includes('execute') ||
    w.includes('run')
  )
    return 'HIGH';
  if (has(CRIT_WORDS)) return 'CRITICAL';
  if (has(SEND_WORDS) && !w.includes('draft')) return 'HIGH';
  if (has(DELETE_WORDS)) return 'HIGH';
  if (has(WRITE_WORDS)) return 'MEDIUM';
  if (has(READ_WORDS)) return 'LOW';
  return 'HIGH';
}

/**
 * What an MCP tool name says about risk. The leading verb decides first, so get_reply_count is a read
 * and send_reply a send; only names without a read verb fall back to any matching word.
 */
export function mcpRisks(toolName: string): RiskFlag[] {
  const w = words(toolName.split('__').slice(2).join('_') || toolName);
  const verb = w[0] ?? '';
  if (READ_WORDS.includes(verb) && verb !== 'navigate' && verb !== 'open') return [];
  const out: RiskFlag[] = [];
  const pick = (list: string[]) => (list.includes(verb) ? true : w.some((x) => list.includes(x)));
  if (pick(SEND_WORDS) && !w.includes('draft')) out.push('sends');
  if (pick(DELETE_WORDS)) out.push('deletes');
  if (pick(CRIT_WORDS)) out.push('system');
  return out;
}

/**
 * Full trust still asks for HIGH calls with any risk flag: sends, deletes, installs, network commands,
 * encoded commands, changes outside the work folders and scheduled work. Everything else HIGH runs.
 */
export function stillAsksInFullTrust(c: Pick<Classification, 'risks'>): boolean {
  return (c.risks?.length ?? 0) > 0;
}

function classifyMcp(toolName: string, input: Record<string, unknown>, cwd: string, ctx: TierContext): Classification {
  const tool = toolName.split('__').slice(2).join('__');
  const w = words(tool);

  if (toolName.startsWith(OWN_SERVER)) {
    // Files go to the owner's own chat. Blocked paths stay blocked.
    const target = str(input.path);
    if (target) {
      const { verdict } = checkPath(target, cwd, ctx.policy);
      if (verdict === 'deny') return { tier: 'DENY', reason: 'blocked path', taints: false, sends: false };
      if (verdict === 'outside')
        return { tier: 'MEDIUM', reason: 'file outside work folders', taints: false, sends: false };
    }
    return { tier: 'LOW', reason: 'reply to the owner', taints: false, sends: false };
  }
  const risks = mcpRisks(toolName);

  const url = str(input.url);
  const domain = url ? domainOf(url) : undefined;
  const sends = risks.includes('sends');
  const reads = w.some((x) => READ_WORDS.includes(x));
  const taints = reads && TAINT_HINT.test(toolName);

  // Browser "computer" tools: look at the action.
  if (w.includes('computer') && typeof input.action === 'string') {
    const action = input.action.toLowerCase();
    const passive = /screenshot|scroll|zoom|wait|hover|mouse_move/.test(action);
    return { tier: passive ? 'LOW' : 'MEDIUM', reason: `browser ${action}`, taints: passive, sends: false };
  }

  const confirmed = ctx.overrides.get(toolName);
  if (confirmed) {
    return {
      tier: confirmed,
      reason: `owner-confirmed tier for ${tool}`,
      taints,
      sends,
      risks,
      ...(domain ? { domain } : {}),
    };
  }
  const suggested = suggestMcpTier(toolName);
  return {
    tier: suggested === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
    reason: `new tool ${tool} (suggested ${suggested}; confirm on the PC with "wa-operator tiers")`,
    taints,
    sends,
    risks,
    unconfirmed: { suggested },
    ...(domain ? { domain } : {}),
  };
}
