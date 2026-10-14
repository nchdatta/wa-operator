import { checkPath, type PathPolicy } from './paths.js';
import { maxTier, type Tier } from './tier.js';

/**
 * Shell commands are parsed, not pattern-matched. Only known read-only commands with checked paths
 * are LOW. Chaining, substitution, variables, escapes, encoded commands, `iex` and unknown programs
 * make a command HIGH; secret and env-dump access is DENY.
 */

export type ShellFlavor = 'bash' | 'powershell';

export interface ShellAnalysis {
  tier: Tier;
  reasons: string[];
  /** Talks to the network (curl, Invoke-WebRequest, ssh, …): a "send" for taint purposes. */
  network: boolean;
  /** What kind of risk the command carries; full trust decides on these, not on the reason text. */
  risks: RiskFlag[];
}

export type RiskFlag = 'deletes' | 'installs' | 'network' | 'outside' | 'encoded' | 'schedules' | 'sends' | 'system';

type Tok = { t: 'word'; v: string; quoted: boolean } | { t: 'op'; v: string } | { t: 'block'; v: string };

interface Lexed {
  toks: Tok[];
  dynamic: string[];
}

const SECRET_VARS =
  /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|WHATSAPP_ACCESS_TOKEN|META_APP_SECRET|META_VERIFY_TOKEN|TELEGRAM_BOT_TOKEN|wa-operator:/i;

export function lex(cmd: string, flavor: ShellFlavor): Lexed {
  const toks: Tok[] = [];
  const dynamic: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  const push = () => {
    if (has) toks.push({ t: 'word', v: cur, quoted });
    cur = '';
    quoted = false;
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const n = cmd[i + 1];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) {
        dynamic.push('unterminated quote');
        cur += cmd.slice(i + 1);
        has = true;
        break;
      }
      cur += cmd.slice(i + 1, end);
      quoted = has = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        const d = cmd[j]!;
        if (d === '$' && /[\w({:]/.test(cmd[j + 1] ?? '')) dynamic.push('variable or substitution in quotes');
        if (d === '`') dynamic.push(flavor === 'bash' ? 'command substitution' : 'escape character');
        if (d === '\\' && flavor === 'bash' && j + 1 < cmd.length) {
          s += cmd[++j];
          continue;
        }
        s += d;
      }
      if (j >= cmd.length) dynamic.push('unterminated quote');
      cur += s;
      quoted = has = true;
      i = j;
      continue;
    }
    if (c === '`') {
      dynamic.push(flavor === 'bash' ? 'command substitution' : 'escape character');
      continue;
    }
    if (c === '\\' && flavor === 'bash') {
      if (n === '\n') {
        i++;
        continue;
      }
      cur += n ?? '';
      has = true;
      i++;
      continue;
    }
    if (c === '$') {
      const rest = cmd.slice(i + 1);
      if (rest.startsWith('(')) dynamic.push('subexpression');
      else if (/^\{|^[A-Za-z_?]/.test(rest)) {
        const m = /^\{?([A-Za-z_][\w:]*|\?)\}?/.exec(rest);
        const name = (m?.[1] ?? '').toLowerCase();
        if (flavor === 'powershell' && ['true', 'false', 'null', '_', 'psitem'].includes(name)) {
          // harmless automatic variables
        } else dynamic.push(`variable $${m?.[1] ?? ''}`);
      }
      cur += c;
      has = true;
      continue;
    }
    if (flavor === 'powershell' && c === '@' && n === '(') dynamic.push('subexpression');
    if (c === '{') {
      let depth = 1;
      let j = i + 1;
      for (; j < cmd.length && depth > 0; j++) {
        if (cmd[j] === '{') depth++;
        else if (cmd[j] === '}') depth--;
      }
      push();
      toks.push({ t: 'block', v: cmd.slice(i + 1, j - 1) });
      i = j - 1;
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';') {
      push();
      toks.push({ t: 'op', v: ';' });
      continue;
    }
    if (c === '&' || c === '|') {
      push();
      if (n === c) {
        toks.push({ t: 'op', v: c + c });
        i++;
      } else toks.push({ t: 'op', v: c });
      continue;
    }
    if (c === '>' || c === '<') {
      // 2>&1, 2>$null, >nul, >/dev/null are harmless; anything else is a redirect to check.
      const fd = /\d$/.test(cur) && !quoted ? cur.slice(-1) : '';
      if (fd) cur = cur.slice(0, -1);
      if (cur) has = true;
      push();
      let op = c;
      if (n === '>') {
        op = '>>';
        i++;
      }
      if (cmd[i + 1] === '&') {
        i += 2;
        continue; // fd duplication
      }
      toks.push({ t: 'op', v: op });
      continue;
    }
    if (c === '(' || c === ')') {
      push();
      dynamic.push('grouping');
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return { toks, dynamic };
}

// ---- command sets -------------------------------------------------------------------------------

const READ_ONLY = new Set([
  'dir',
  'ls',
  'gci',
  'get-childitem',
  'tree',
  'pwd',
  'get-location',
  'gl',
  'cat',
  'type',
  'gc',
  'get-content',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'file',
  'stat',
  'get-item',
  'gi',
  'get-itemproperty',
  'gp',
  'test-path',
  'resolve-path',
  'split-path',
  'join-path',
  'get-filehash',
  'get-psdrive',
  'get-volume',
  'get-disk',
  'get-partition',
  'du',
  'df',
  'get-date',
  'date',
  'get-process',
  'ps',
  'gps',
  'get-service',
  'gsv',
  'whoami',
  'hostname',
  'get-computerinfo',
  'systeminfo',
  'ipconfig',
  'get-netipaddress',
  'ping',
  'test-connection',
  'echo',
  'write-output',
  'write-host',
  'printf',
  'select-object',
  'select',
  'where-object',
  'where',
  '?',
  'sort-object',
  'sort',
  'measure-object',
  'measure',
  'group-object',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'format-wide',
  'out-string',
  'convertto-json',
  'convertfrom-json',
  'convertto-csv',
  'import-csv',
  'select-string',
  'sls',
  'findstr',
  'grep',
  'rg',
  'find',
  'uniq',
  'cut',
  'tr',
  'awk',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'which',
  'where.exe',
  'get-command',
  'get-ciminstance',
  'get-wmiobject',
  'gwmi',
  'foreach-object',
  '%',
  'get-acl',
  'get-help',
  'tasklist',
  'node',
  'npm',
  'git',
  'python',
  'py',
  'pip',
  'cd',
  'set-location',
  'sl',
  'chdir',
  'start-sleep',
  'sleep',
]);

/** Commands that are read-only only with these first arguments. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'status',
    'log',
    'diff',
    'show',
    'branch',
    'remote',
    'rev-parse',
    'ls-files',
    'blame',
    'describe',
    'tag',
  ]),
  node: new Set(['--version', '-v']),
  npm: new Set(['--version', '-v', 'ls', 'list', 'view', 'outdated']),
  python: new Set(['--version', '-V']),
  py: new Set(['--version', '-V']),
  pip: new Set(['list', 'show', 'freeze', '--version']),
};

const BAD_ARGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/,
  awk: /system|>|\|/,
  'foreach-object': /./, // only allowed with a checked script block (no plain args)
  '%': /./,
  'get-ciminstance': /^-(?!classname$|class$|filter$|property$)/i,
};

const DELETE = new Set([
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'remove-item',
  'ri',
  'unlink',
  'shred',
  'clear-content',
  'clc',
  'clear-recyclebin',
]);

const WRITE = new Set([
  'cp',
  'copy',
  'copy-item',
  'cpi',
  'mv',
  'move',
  'move-item',
  'mi',
  'ren',
  'rename',
  'rename-item',
  'rni',
  'mkdir',
  'md',
  'new-item',
  'ni',
  'touch',
  'set-content',
  'add-content',
  'ac',
  'out-file',
  'tee',
  'tee-object',
  'robocopy',
  'xcopy',
  'expand-archive',
  'compress-archive',
  'tar',
  'unzip',
  'zip',
  '7z',
  'sed',
  'export-csv',
  'chmod',
  'chown',
  'attrib',
  'mklink',
]);

const CRITICAL = new Set([
  'shutdown',
  'restart-computer',
  'stop-computer',
  'reg',
  'regedit',
  'format',
  'format-volume',
  'diskpart',
  'bcdedit',
  'vssadmin',
  'cipher',
  'takeown',
  'icacls',
  'cacls',
  'net',
  'set-executionpolicy',
  'wevtutil',
  'clear-eventlog',
  'remove-itemproperty',
  'set-itemproperty',
  'new-itemproperty',
  'mkfs',
  'dd',
  'sc',
  'clear-disk',
  'initialize-disk',
  'remove-partition',
  'disable-computerrestore',
  'logoff',
  'reboot',
  'poweroff',
  'halt',
  'stop-process',
  'kill',
  'taskkill',
  'set-mppreference',
  'netsh',
  'new-localuser',
  'add-localgroupmember',
  'remove-localuser',
]);

const NETWORK = new Set([
  'curl',
  'curl.exe',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'send-mailmessage',
  'bitsadmin',
  'start-bitstransfer',
  'certutil',
  'rsync',
]);

const RUNS_CODE = new Set([
  'iex',
  'invoke-expression',
  'invoke-command',
  'icm',
  'start-process',
  'saps',
  'start',
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'wsl',
  'cscript',
  'wscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'add-type',
  'invoke-item',
  'ii',
  'explorer',
  'eval',
  'exec',
  'source',
  '.',
  '&',
  'xargs',
  'env',
  'nohup',
  'sudo',
  'runas',
  'schtasks',
  'register-scheduledtask',
  'launchctl',
  'systemctl',
  'crontab',
  'osascript',
  'doas',
  'pkexec',
  'new-service',
  'set-alias',
  'new-alias',
  'function',
  'import-module',
]);

const INSTALL = new Set([
  'winget',
  'choco',
  'scoop',
  'msiexec',
  'apt',
  'apt-get',
  'brew',
  'install-module',
  'install-package',
]);

const ENV_DUMP = new Set([
  'printenv',
  'set',
  'export',
  'declare',
  'get-variable',
  'gv',
  'dir-env',
  'cmdkey',
  'vaultcmd',
  'security',
  'secret-tool',
]);
/** Credential stores: any use is blocked, not only a bare dump. */
const CRED_TOOLS = new Set(['cmdkey', 'vaultcmd', 'security', 'secret-tool']);

function cmdName(word: string): string {
  const base = word.split(/[\\/]/).pop()!.toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/, '') || base;
}

function looksLikePath(w: string): boolean {
  if (/^-{1,2}[A-Za-z]/.test(w) || /^\/[A-Za-z?]$/.test(w)) return false; // flags (-Recurse, --all, /s)
  if (/^https?:\/\//i.test(w)) return false;
  return /[\\/]|^\.|^~|^[A-Za-z]:|\.\w{1,6}$|\*/.test(w);
}

/** PowerShell script block: allowed only when it is a filter over $_ (no commands inside). */
function safeBlock(block: string): boolean {
  const words = block
    .replace(/\(|\)|!/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.every(
      (w) =>
        /^(\$_|\$PSItem)(\.[\w.]+)?$/i.test(w) ||
        /^-[a-z]+$/i.test(w) ||
        /^[\d.]+(KB|MB|GB|TB)?$/i.test(w) ||
        /^'[^']*'$/.test(w) ||
        /^"[^"$`]*"$/.test(w) ||
        /^\$(true|false|null)$/i.test(w) ||
        /^[\w.*]+$/.test(w),
    ) && !/\b(iex|invoke-|remove-|set-|new-|start-|stop-|out-|add-)/i.test(block)
  );
}

export function analyzeShell(command: string, flavor: ShellFlavor, cwd: string, policy: PathPolicy): ShellAnalysis {
  const reasons: string[] = [];
  let tier: Tier = 'LOW';
  let network = false;
  const risks = new Set<RiskFlag>();
  const raise = (t: Tier, why: string, risk?: RiskFlag) => {
    tier = maxTier(tier, t);
    reasons.push(why);
    if (risk) risks.add(risk);
  };

  if (!command.trim()) return { tier: 'LOW', reasons: ['empty'], network, risks: [] };
  if (SECRET_VARS.test(command)) raise('DENY', 'touches a secret');
  // Dumping the environment is DENY; reading one ordinary variable ($env:USERPROFILE) is just dynamic (HIGH).
  if (/\benv:(?![A-Za-z_])|env:\\?\*|\[(System\.)?Environment\]::GetEnvironmentVariables/i.test(command))
    raise('DENY', 'dumps environment variables');
  else if (/\[(System\.)?Environment\]/i.test(command)) raise('HIGH', 'reads environment variables');
  if (/(^|[\s'"\\/])\.env(\.\w+)?(?=$|[\s'"\\/;|&)])/i.test(command)) raise('DENY', 'touches a .env file');
  if (/-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+[A-Za-z0-9+/=]{8,}/i.test(command))
    raise('HIGH', 'encoded command', 'encoded');
  if (/frombase64string|\bdownloadstring\b|\bnet\.webclient\b/i.test(command))
    raise('HIGH', 'decodes or downloads code', 'encoded');
  // Deleting through .NET or the shell (Recycle Bin moves included) still counts as deleting.
  if (/DeleteFile|DeleteDirectory|RecycleBin|RecycleOption|InvokeVerb\s*\(\s*['"]?delete|\.Delete\s*\(|\bRemove-Item\b/i.test(command))
    raise('HIGH', 'deletes inside the work folders', 'deletes');

  const { toks, dynamic } = lex(command, flavor);
  for (const d of new Set(dynamic)) raise('HIGH', d);

  // Split into chained statements and pipeline segments.
  const segments: Tok[][] = [[]];
  for (const tok of toks) {
    if (tok.t === 'op' && [';', '&&', '||', '&'].includes(tok.v)) {
      if (tok.v === '&' && segments.at(-1)!.length === 0) {
        raise('HIGH', 'call operator');
        continue;
      }
      raise('HIGH', 'chained commands');
      segments.push([]);
    } else if (tok.t === 'op' && tok.v === '|') segments.push([]);
    else segments.at(-1)!.push(tok);
  }

  for (const seg of segments) {
    if (seg.length === 0) continue;
    const first = seg[0]!;
    if (first.t !== 'word') {
      raise('HIGH', 'unexpected syntax');
      continue;
    }
    const name = cmdName(first.v);
    const args: Tok[] = seg.slice(1);
    // Words, minus redirect targets (checked separately below).
    const words = args.filter(
      (a, i): a is Extract<Tok, { t: 'word' }> => a.t === 'word' && !(i > 0 && args[i - 1]!.t === 'op'),
    );

    // Redirects: `> file` writes, `< file` reads.
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a.t !== 'op') continue;
      const target = args[i + 1];
      const tv = target && target.t === 'word' ? target.v : '';
      if (/^(\$null|nul|\/dev\/null)$/i.test(tv)) continue;
      const pv = tv ? checkPath(tv, cwd, policy).verdict : 'outside';
      if (pv === 'deny') raise('DENY', `redirect touches a blocked path`);
      else if (a.v === '<') {
        if (pv === 'outside') raise('MEDIUM', 'reads outside the work folders');
      } else raise('HIGH', 'writes a file through a redirect', pv === 'outside' ? 'outside' : undefined);
    }

    const pathVerdicts = words
      .filter((w) => looksLikePath(w.v))
      .map((w) => ({ w: w.v, ...checkPath(w.v, cwd, policy) }));
    if (pathVerdicts.some((p) => p.verdict === 'deny')) raise('DENY', 'touches a blocked path');
    const outside = pathVerdicts.some((p) => p.verdict === 'outside');

    if (ENV_DUMP.has(name) && (words.length === 0 || CRED_TOOLS.has(name) || /^-p$/.test(words[0]?.v ?? '')))
      raise('DENY', 'dumps environment or stored credentials');
    else if (name === 'env' && words.length === 0) raise('DENY', 'dumps environment');
    else if (name === 'git' && (words[0]?.v ?? '').toLowerCase() === 'push') raise('CRITICAL', 'git push', 'network');
    else if (CRITICAL.has(name)) raise('CRITICAL', `${name} changes the system`, 'system');
    else if (DELETE.has(name)) {
      if (pathVerdicts.length === 0 || outside) raise('CRITICAL', 'deletes outside the work folders', 'deletes');
      else raise('HIGH', 'deletes inside the work folders', 'deletes');
    } else if (NETWORK.has(name)) {
      network = true;
      raise('HIGH', `${name} uses the network`, 'network');
    } else if (RUNS_CODE.has(name)) raise('HIGH', `${name} runs other code`);
    else if (INSTALL.has(name)) raise('HIGH', 'installs software', 'installs');
    else if (WRITE.has(name)) raise('HIGH', `${name} changes files`, outside ? 'outside' : undefined);
    else if (READ_ONLY.has(name)) {
      const sub = SUBCOMMANDS[name];
      const firstArg = (words[0]?.v ?? '').toLowerCase();
      const bad = BAD_ARGS[name];
      const blocks = args.filter((a) => a.t === 'block');
      if (sub && !sub.has(firstArg)) raise('HIGH', `${name} ${firstArg || ''}`.trim() + ' is not read-only');
      else if (bad && words.some((w) => bad.test(w.v))) raise('HIGH', `${name} with a write or exec option`);
      else if (blocks.some((b) => !safeBlock(b.v))) raise('HIGH', 'script block runs commands');
      else if (outside) raise('MEDIUM', 'reads outside the work folders');
    } else raise('HIGH', `unknown program ${name}`);
  }
  if (reasons.length === 0) reasons.push('read-only');
  return { tier, reasons: [...new Set(reasons)], network, risks: [...risks] };
}
