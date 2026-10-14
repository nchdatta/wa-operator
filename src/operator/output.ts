import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { OwnerChat } from '../channels/owner-chat.js';
import type { AppContext } from '../context.js';
import { errMsg } from '../shared/errors.js';
import { newId } from '../shared/ids.js';

/**
 * The in-process MCP server `whatsapp-out`: Claude's way to send files, images and screenshots to
 * the owner and to ask a quick question. Every call still passes the PreToolUse gate.
 */

const SENSITIVE_WINDOW =
  /bank|banking|bkash|nagad|rocket|upay|paypal|stripe|payoneer|wise\b|password|passcode|1password|bitwarden|lastpass|keepass|dashlane|credential|otp\b|one-time|card number|cvv|wallet|sign in|log ?in/i;

const SCREENSHOT_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace WaOp -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
'@
[void][WaOp.Win]::SetProcessDPIAware()
$sb = New-Object System.Text.StringBuilder 512
[void][WaOp.Win]::GetWindowText([WaOp.Win]::GetForegroundWindow(), $sb, 512)
$title = $sb.ToString()
if ($title -match $env:WAOP_SENSITIVE) { [Console]::Out.Write("BLOCKED:" + $title); exit 3 }
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($env:WAOP_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[Console]::Out.Write("OK:" + $title)
`;

type Shot = { ok: true; title: string } | { ok: false; reason: string };

function exec(cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/**
 * macOS and Linux. The front window's title is checked first; when it cannot be read there is no
 * screenshot, so a banking or password window is never sent by accident.
 */
async function captureUnix(file: string): Promise<Shot> {
  const mac = process.platform === 'darwin';
  const t = mac
    ? await exec('osascript', [
        '-e',
        'tell application "System Events" to tell (first process whose frontmost is true) to return (name as text) & " - " & (name of front window as text)',
      ])
    : await exec('xdotool', ['getactivewindow', 'getwindowname']);
  if (t.code !== 0)
    return {
      ok: false,
      reason: mac
        ? 'cannot read the front window title (allow Terminal/node under System Settings → Privacy & Security → Accessibility)'
        : 'cannot read the front window title (install xdotool; Wayland-only desktops are not supported)',
    };
  if (SENSITIVE_WINDOW.test(t.out))
    return { ok: false, reason: 'a banking or password window is in front, so no screenshot was taken' };
  const tries: [string, string[]][] = mac
    ? [['screencapture', ['-x', file]]]
    : [
        ['gnome-screenshot', ['-f', file]],
        ['scrot', ['-o', file]],
        ['import', ['-window', 'root', file]],
      ];
  for (const [cmd, args] of tries) {
    const r = await exec(cmd, args);
    if (r.code === 0 && fs.existsSync(file)) return { ok: true, title: t.out };
  }
  return {
    ok: false,
    reason: mac
      ? 'screen capture failed (allow Screen Recording under System Settings → Privacy & Security)'
      : 'screen capture failed (install gnome-screenshot, scrot or imagemagick)',
  };
}

export function captureScreen(file: string): Promise<Shot> {
  if (process.platform !== 'win32') return captureUnix(file);
  return new Promise((resolve) => {
    const p = spawn(
      'powershell.exe',
      // Not -Command - : PowerShell reads stdin line by line and silently drops the here-string.
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(SCREENSHOT_PS, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        env: { ...process.env, WAOP_SHOT: file, WAOP_SENSITIVE: SENSITIVE_WINDOW.source },
      },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    p.on('error', (e) => resolve({ ok: false, reason: e.message }));
    p.on('close', (code) => {
      if (code === 0 && out.startsWith('OK:')) resolve({ ok: true, title: out.slice(3) });
      else if (code === 3)
        resolve({ ok: false, reason: 'a banking or password window is in front, so no screenshot was taken' });
      else resolve({ ok: false, reason: `screen capture failed (exit ${code}) ${err.trim().slice(0, 200)}`.trim() });
    });
  });
}

interface PendingQuestion {
  id: string;
  /** Session slot that asked, so ending one task never drops another task's question. */
  owner: string;
  options: string[];
  resolve: (answer: string | null) => void;
}

/**
 * Questions Claude asked the owner with ask_owner, answered by a button tap or the next text. Parallel
 * tasks can each have one open question; a plain text answers the newest.
 */
export class OwnerQuestions {
  private readonly pending: PendingQuestion[] = [];

  constructor(private readonly ttlMs: number) {}

  get open(): boolean {
    return this.pending.length > 0;
  }

  ask(options: string[], send: (id: string) => Promise<void>, owner = '0'): Promise<string | null> {
    this.cancel(owner);
    const id = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, null), this.ttlMs);
      this.pending.push({
        id,
        owner,
        options,
        resolve: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
      });
      send(id).catch(() => this.settle(id, null));
    });
  }

  private settle(id: string, answer: string | null): boolean {
    const i = this.pending.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const [p] = this.pending.splice(i, 1);
    p!.resolve(answer);
    return true;
  }

  /** Button id "ask:<id>:<n>". */
  onButton(buttonId: string): boolean {
    const m = /^ask:([0-9A-HJKMNP-TV-Z]{26}):(\d)$/.exec(buttonId);
    const p = m && this.pending.find((q) => q.id === m[1]);
    if (!m || !p) return false;
    return this.settle(p.id, p.options[Number(m[2])] ?? null);
  }

  onText(text: string): boolean {
    const p = this.pending.at(-1);
    return p ? this.settle(p.id, text) : false;
  }

  /** Drop the open question of one session slot, or every question when no slot is given. */
  cancel(owner?: string): void {
    for (const p of [...this.pending]) if (owner === undefined || p.owner === owner) this.settle(p.id, null);
  }
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export function createWhatsAppOutServer(ctx: AppContext, chat: OwnerChat, questions: OwnerQuestions, slot = '0') {
  const sendFile = (kind: 'document' | 'image') => async (args: { path: string; caption?: string | undefined }) => {
    try {
      const stat = await fs.promises.stat(args.path);
      if (!stat.isFile()) return fail('Not a file.');
      if (stat.size > 100 * 1024 * 1024)
        return fail('File is over 100 MB; WhatsApp will not take it. Compress or split it.');
      await chat.file(args.path, { kind, ...(args.caption ? { caption: args.caption } : {}) });
      audit(ctx, {
        actor: 'claude',
        action: `out.${kind}`,
        outcome: 'ok',
        metadata: { file: path.basename(args.path), bytes: stat.size },
      });
      return ok(`Sent ${path.basename(args.path)} to their phone.`);
    } catch (e) {
      return fail(`Could not send: ${errMsg(e)}`);
    }
  };

  return createSdkMcpServer({
    name: 'whatsapp-out',
    version: '1.0.0',
    alwaysLoad: true,
    instructions: 'Send files, images and screenshots to the owner on their phone, or ask them a short question.',
    tools: [
      tool(
        'send_file',
        'Send a local file (PDF, txt, xlsx, docx, …) to the owner as a document.',
        { path: z.string().describe('Absolute path of the file'), caption: z.string().max(1000).optional() },
        sendFile('document'),
      ),
      tool(
        'send_image',
        'Send a local PNG or JPEG image to the owner.',
        { path: z.string().describe('Absolute path of the image'), caption: z.string().max(1000).optional() },
        sendFile('image'),
      ),
      tool(
        'screenshot',
        'Take a screenshot of the whole PC screen and send it to the owner. Refuses while a banking or password window is in front.',
        { caption: z.string().max(1000).optional() },
        async (args) => {
          const dir = path.join(ctx.config.outbox, 'screenshots');
          await fs.promises.mkdir(dir, { recursive: true });
          const file = path.join(dir, `screen-${new Date(ctx.clock.now()).toISOString().replace(/[:.]/g, '-')}.png`);
          const shot = await captureScreen(file);
          if (!shot.ok) {
            audit(ctx, {
              actor: 'claude',
              action: 'out.screenshot',
              outcome: 'refused',
              metadata: { reason: shot.reason },
            });
            return fail(`No screenshot: ${shot.reason}.`);
          }
          await chat.file(file, { kind: 'image', ...(args.caption ? { caption: args.caption } : {}) });
          audit(ctx, { actor: 'claude', action: 'out.screenshot', outcome: 'ok' });
          return ok(`Screenshot sent (front window: ${shot.title || 'desktop'}).`);
        },
      ),
      tool(
        'ask_owner',
        'Ask the owner a short question and wait (up to 5 minutes) for the answer. Give up to 3 short options when possible.',
        {
          question: z.string().min(1).max(900),
          options: z.array(z.string().min(1).max(20)).max(3).optional(),
        },
        async (args) => {
          const options = args.options ?? [];
          const answer = await questions.ask(options, async (id) => {
            if (options.length) {
              await chat.buttons(
                `❓ ${args.question}`,
                options.map((title, i) => ({ id: `ask:${id}:${i}`, title })),
              );
            } else await chat.say(`❓ ${args.question}`);
          }, slot);
          return answer === null
            ? fail('No answer in time. Choose a safe default or stop.')
            : ok(`They answered: ${answer}`);
        },
      ),
    ],
  });
}
