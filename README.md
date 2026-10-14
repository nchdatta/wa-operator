# WhatsApp Operator Mode

The business owner uses Claude from their phone. They message one dedicated WhatsApp number, and Claude works on the shop PC: files, commands, the browser, apps and every connected MCP service. Answers, files and approval requests come back in the same chat.

The system has one user: the owner. It has no customers, no team, and no other agents. Messages from any other sender are dropped silently and logged.

This is a lean project built from the WhatsApp, approval and audit parts of [`../whatsapp-mcp`](../whatsapp-mcp). It runs on Node 24, TypeScript, the Claude Agent SDK on the owner's subscription, SQLite (WAL) with Drizzle, Zod and pino.

## How a message flows

```
Meta webhook (signed) ─► store job (SQLite) ─► 200 OK
                                 │
   job processor ─► sender == operator?  no ─► drop, no reply, audit
                                 │ yes
   1. approval button / PIN Flow / answer ─► approval engine · gate · ask_owner
   2. /stop /status /new /trust /lock /kill /help
   3. instruction ─► (PIN unlock if locked) ─► run queue (one at a time) ─► warm Agent SDK session
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

`/stop` · `/status` · `/new` · `/trust on|off` · `/lock` · `/kill` · `/help`. Anything else is an instruction.

## Commands at the PC

```
npm run cli -- set-pin | enable | disable | status | check
npm run cli -- tiers [list|accept|set <tool> <tier>|reset <tool>]
npm run cli -- secret set|list|delete <NAME>
npm run cli -- logs [-n 50]
npm run cli -- import-desktop-mcp
```

Everything that loosens security happens only at the PC, never from WhatsApp: setting the PIN, re-enabling after a lockout, confirming tiers and managing secrets.

## Setup

See [docs/setup.md](docs/setup.md). It covers the dedicated number, the PIN Flow, the named tunnel, autostart, the cloud watcher and the Telegram fallback.

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
