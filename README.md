# WhatsApp Operator Mode

WhatsApp Operator Mode is a human-in-the-loop AI agent. The business owner uses it from their phone. They message one dedicated WhatsApp number, and Claude works on the shop PC: files, commands, the browser, apps and every connected MCP service. Answers, files and approval requests come back in the same chat.

The system has one user: the owner. It has no customers, no team, and no other users or bots. Messages from any other sender are dropped silently and logged.

This is a lean project built from the WhatsApp, approval and audit parts of [`../whatsapp-mcp`](../whatsapp-mcp). It runs on Node 24, TypeScript, the Claude Agent SDK on the owner's subscription, SQLite (WAL) with Drizzle, Zod and pino.

## How a message flows

```
Meta webhook (signed) ─► store job (SQLite) ─► 200 OK
                                 │
   job processor ─► sender == operator?  no ─► drop, no reply, audit
                                 │ yes
   1. approval button / PIN Flow / answer ─► approval engine · gate · ask_owner
   2. /stop /status /queue /cancel /new /trust /lock /kill /help
   3. instruction ─► (PIN unlock if locked) ─► run queue (OPERATOR_PARALLEL slots, default 2) ─► warm Agent SDK session per slot
                                                       │
            PreToolUse hook on EVERY tool call ─► tiers ─► allow · card · card+PIN · deny
```

## Safety tiers

| Tier | Examples | Handling |
| --- | --- | --- |
| LOW | read files in work folders, search, list, read-only commands, browse, screenshots | runs, logged |
| MEDIUM | edit files in work folders, reads outside them, sheet rows, Drive saves | runs in trusted mode, otherwise one tap |
| HIGH | send email or messages, run commands, install, invites, edits outside work folders, **unconfirmed MCP tools** | card with the exact action: ✅ / ✏️ / ❌ |
| CRITICAL | delete outside work folders, payments, registry, `git push`, shutdown | card and PIN, every time |
| DENY | `.env`, keys, browser profiles, Credential Manager, this app's code, data and audit log, env dumps | always blocked, owner alerted |

How the tiers are applied:

- **Shell commands are parsed** ([src/operator/shell.ts](src/operator/shell.ts)). Only allowlisted read-only commands are LOW. Chaining, substitution, variables, escapes, `-EncodedCommand`, `iex` and unknown programs make a command HIGH.
- **Paths are resolved first** ([src/operator/paths.ts](src/operator/paths.ts)): `..`, `~`, `%VAR%`, symlinks, junctions and 8.3 short names are resolved before the folder check. This applies to every tool, the shell included.
- **Taint** ([src/operator/taint.ts](src/operator/taint.ts)): once a task has read a web page, an email or a downloaded file, any send, upload or visit to a new website moves up one tier.
- **Hard backstop**: `disallowedTools` rules, plus `canUseTool`, which denies anything the hook did not approve.

## Commands from the phone

`/stop` · `/status` · `/queue` · `/cancel N` · `/new` · `/trust full|on|off` · `/lock` · `/kill` · `/help`. Anything else is an instruction; a new one starts beside a running task, and a short "continue" (or a reply to the task) joins it. New installs start in full trust.

## Commands at the PC

```
npm run cli -- set-pin | enable | disable | status | check
npm run cli -- tiers [list|accept|set <tool> <tier>|reset <tool>]
npm run cli -- secret set|list|delete <NAME>
npm run cli -- logs [-n 50]
npm run cli -- import-desktop-mcp
```

Everything that loosens security happens only at the PC, never from WhatsApp: setting the PIN, re-enabling after a lockout, confirming tiers and managing secrets.

## Install

One line, with no git, Node or npm needed. It installs WA Operator and Claude Code (from Anthropic's official installer), then runs the quick setup: business details, Claude login, link the WhatsApp number by QR, PIN, start.

Windows (PowerShell):
```
irm https://github.com/nchdatta/wa-operator/releases/latest/download/install.ps1 | iex
```
macOS / Linux:
```
curl -fsSL https://github.com/nchdatta/wa-operator/releases/latest/download/install.sh | bash
```

Then, in any terminal: `wa-operator setup [--advanced]`, `start`, `stop`, `restart`, `running`, `update`, `uninstall`, plus the PC commands above (`wa-operator tiers`, `wa-operator set-pin`…). The app lives in `%LOCALAPPDATA%\Programs\WA Operator` or `~/.local/share/wa-operator`. Settings and data live in `%APPDATA%\wa-operator`, `~/Library/Application Support/wa-operator` or `~/.config/wa-operator`, so updates keep them.

Releasing: bump `version` in package.json, then `git tag v<version> && git push --tags`. `.github/workflows/release.yml` builds every platform (`node scripts/package.mjs`) and publishes a release in this repo.

## Setup from a git checkout

The old way still works: clone, then `install.cmd` / `./install.sh` (or `npm install && npm run setup`). Files stay in the repo folder. See [docs/setup.md](docs/setup.md). It covers the dedicated number, the PIN Flow, the named tunnel, autostart, the cloud watcher and the Telegram fallback.

## Development

```
npm run typecheck && npm run lint && npm test
npm run dev        # service with tsx
```

## Status against the plan

| Phase | Status |
| --- | --- |
| 1 · Ask and read | Built: webhook and job queue, `channels/` (WhatsApp and Telegram), PIN gate through a Flow, parsed shell commands, real-path checks, OS secret store (Credential Manager, Keychain, keyring), warm session with resume, files back, `/stop` and `/status`, autostart script, watcher |
| 2 · Approvals | Built: MEDIUM/HIGH/CRITICAL engine with 5-minute expiry and hook timeout, ✏️ Edit, trusted mode, taint, screenshot block on banking and password windows, usage governor |
| 2b · Voice notes | Built (optional): whisper.cpp client with an "I heard" echo |
| 3 · Browser and apps | Works through connected MCPs (Chrome MCP tools are tiered by action). No extra code yet |
| 4 · Routines | Not started (the governor already has `canRunRoutine()`) |
| 5 · Hub on a VPS | Not started |
