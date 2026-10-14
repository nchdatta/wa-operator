# Setup

## Fast path: the wizard

Windows: double-click **install.cmd**. If Node 24 or cloudflared is missing, it installs them with winget. macOS and Linux: run **./install.sh** (see [macOS and Linux](#macos-and-linux)). Then it runs `npm install` and starts the wizard. It does the same as:

```powershell
cd operator-mode
npm install
npm run setup
```

The wizard does every step below. It asks a few questions and opens a browser where a login is needed (Claude, Cloudflare, wrangler). Each step is safe to re-run on its own, e.g. `npm run setup -- --only webhook` or `--skip watcher`.

The steps, in order: `build, env, claude, meta, flow, templates, pin, tunnel, autostart, webhook, autologon, watcher`.

What stays manual:
- Create the Meta app, the separate WhatsApp Business Account, its number and the System User token. Meta has no API for these. The wizard asks for the IDs and the token.
- In the BIOS, set "Restore on AC power loss" to Power On.

The sections below describe the same steps done by hand.

Setup takes about an hour, done once at the shop PC. Steps 1 to 4 are needed before the first message. Steps 5 and 6 keep the PC reachable.

## 1. Install

```powershell
cd operator-mode
npm install
npm run build
copy .env.example .env      # then edit .env
```

Fill in `OPERATOR_WA_ID` (the owner's personal number, digits only) and `OPERATOR_ROOTS` (the folders Claude may change). Also set `BUSINESS_NAME` and `BUSINESS_DESCRIPTION`.

## 2. Claude subscription

Operator Mode runs on the owner's own Claude subscription through the Agent SDK.

```powershell
claude setup-token                                   # log in, copy the long-lived token
npm run cli -- secret set CLAUDE_CODE_OAUTH_TOKEN    # paste it (hidden)
```

All secrets are kept in the system secret store (Windows Credential Manager, macOS Keychain or the Linux keyring) under `wa-operator:*`, never in `.env`. Claude's own tools are blocked from reading them.

## 3. A dedicated WhatsApp number

1. In Meta Business Manager, create a **separate WhatsApp Business Account** for this number. Then if Meta ever acts on it, nothing else is affected.
2. Add the number. Give it a display name that makes the internal purpose clear, e.g. "Rahim Fashion Ops".
3. Create a System User token with `whatsapp_business_messaging` and `whatsapp_business_management`, then store the secrets:
   ```powershell
   npm run cli -- secret set WHATSAPP_ACCESS_TOKEN
   npm run cli -- secret set META_APP_SECRET
   npm run cli -- secret set META_VERIFY_TOKEN     # any random string of 32+ characters
   ```
4. Put `WHATSAPP_PHONE_NUMBER_ID` in `.env`.

### PIN Flow

The PIN is entered in a WhatsApp Flow password field, so it never sits in the chat as a message.

1. WhatsApp Manager → Flows → Create Flow (no endpoint) → paste [config/flows/pin-flow.json](../config/flows/pin-flow.json) → Publish.
2. Put its ID in `OPERATOR_PIN_FLOW_ID`.
3. Check the Flow once on the owner's phone. After submitting, the chat shows a "response sent" bubble. Make sure that bubble does not show the PIN. [VERIFY: WhatsApp masks password inputs in the response summary.]

### Templates

These are only needed when something happens outside the 24-hour window:

| Name | Category | Body (example) | Used by |
| --- | --- | --- | --- |
| `operator_result_ready` | Utility | "Your task on the shop PC has a result. Reply to see it." | `OPERATOR_REPLY_TEMPLATE` |
| `operator_pc_offline` | Utility | "The shop PC is not responding." | cloud watcher |
| `operator_pc_online` | Utility | "The shop PC is back online." | cloud watcher |

Nothing proactive is sent otherwise: the PIN is only asked after the owner writes first.

## 4. PIN and first start

```powershell
npm run cli -- set-pin       # 4–12 digits, not 1234 / 1111
npm run cli -- check         # validates config, Meta, Flow, PIN
npm start          # starts the background service (after setup -- --only autostart); npm run dev runs it in this window
```

The service listens on `127.0.0.1:3100`. Next, expose it with a named tunnel:

```powershell
cloudflared tunnel login
cloudflared tunnel create wa-operator
cloudflared tunnel route dns wa-operator ops.example.com
# copy scripts/cloudflared-config.example.yml to %USERPROFILE%\.cloudflared\config.yml and edit it
cloudflared service install
```

In the Meta App Dashboard → WhatsApp → Configuration, set the callback URL to `https://ops.example.com/webhooks/whatsapp` with your verify token, and subscribe to `messages`.

A quick `trycloudflare.com` link is not enough: it changes on every restart and Meta stops delivering.

### MCP tools

Operator Mode loads the owner's Claude Code user settings and MCP servers. To bring Claude Desktop's servers too:

```powershell
npm run cli -- import-desktop-mcp
```

After the first start, every MCP tool is listed with a suggested tier. Until the owner confirms them, unconfirmed tools run as HIGH, which means a card every time:

```powershell
npm run cli -- tiers                # review
npm run cli -- tiers accept         # accept all suggestions, or:
npm run cli -- tiers set mcp__claude_ai_Gmail__search_threads LOW
```

## 5. Always reachable

```powershell
npm run setup -- --only autostart
```

This starts Operator Mode at logon in the owner's session, so GUI apps and screenshots work. It runs without admin rights and restarts on failure. It also turns off sleep on mains power.

Two more steps are done by hand:

- **Autologon, then lock.** Use [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon), so that a Windows Update reboot does not leave the PC stuck at the login screen. Add a Task Scheduler "At log on" task that runs `rundll32.exe user32.dll,LockWorkStation` to lock the screen right away.
- **BIOS:** set "Restore on AC power loss" to *Power On*.

## 6. Cloud watcher

A PC that is down cannot report itself. The watcher in [scripts/watcher](../scripts/watcher) is a free Cloudflare Worker. It pings `/health/live` every 5 minutes and sends the offline/online templates.

```powershell
cd scripts\watcher
npx wrangler kv namespace create WATCH      # put the id in wrangler.toml, edit the vars
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler deploy
```

## macOS and Linux

Same app, same commands. What differs:

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `install.cmd` | `./install.sh` (cloudflared via Homebrew) | `./install.sh` (install Node 24 and cloudflared first) |
| Secrets | Credential Manager | Keychain | keyring (`secret-tool`); on a server with no keyring, `~/.config/wa-operator/secrets.json`, readable only by you |
| Autostart | Task Scheduler, at logon | launchd agent, at logon | systemd user service, at boot (linger) |
| Keep awake | power plan | `caffeinate` while the service runs | by hand: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` |
| Login after reboot | Autologon step | System Settings → Users & Groups → Automatically log in | not needed |
| Screenshots | built in | allow Screen Recording and Accessibility for the terminal / node | needs `xdotool` plus `gnome-screenshot`, `scrot` or ImageMagick (X11) |

Run setup as your normal user, never with sudo. On a Linux server without a keyring, the secrets file is **not encrypted**: only file permissions protect it (like SSH keys). Install `gnome-keyring` (or another Secret Service keyring) for encrypted storage.

## Data encryption

Everything Operator Mode stores is encrypted at rest:
- `data/operator.db` (history, approvals, exact actions, queued messages): SQLCipher, AES-256.
- `data/baileys-auth/` (WhatsApp link session): AES-256-GCM per file.

The key (`OPERATOR_DATA_KEY`) is made on first start and kept in the system secret store, never next to the data. Older unencrypted files are encrypted automatically on first start. If the key is lost (Windows reinstall, `secret delete`), the old data cannot be read: delete `data/` and set the PIN again. `npm run uninstall` keeps the key unless `--purge` also deletes the data.

## Baileys: WhatsApp without Meta

`CHANNEL=baileys` connects the Operator number as a **linked device** (like WhatsApp Web) through [Baileys](https://github.com/WhiskeySockets/Baileys). No Meta app, access token, webhook, tunnel, Flow or template, and no 24-hour window.

> **Warning:** this is not an official WhatsApp API and breaks WhatsApp's terms. The number can be banned. Use a spare number, never the business number.

1. Put a spare number's WhatsApp on a phone. Set `CHANNEL=baileys` and `OPERATOR_WA_ID` (the owner's personal number) in `.env`.
2. Stop the service (`npm stop`), then run `npm run cli -- baileys link` and scan the QR from that phone: **Settings → Linked devices → Link a device**. Or `npm run cli -- baileys link --pair 8801XXXXXXXXX` (the spare number) for an 8-character code.
3. `npm start`. Message the spare number from the owner's phone.

Differences from the Cloud API:
- Buttons and lists arrive as numbered text; the owner replies with the number.
- The PIN is a text reply to the prompt. WhatsApp does not let the bot delete it, so the owner deletes it ("Delete for everyone").
- Photos or files sent before a service restart must be sent again.
- The session lives in `data/baileys-auth` (or `BAILEYS_AUTH_DIR`), encrypted. If the phone logs the device out, run `baileys link --reset`.

## Telegram fallback

If Meta's terms tighten, switch the owner to a Telegram bot the same day. Nothing else changes.

1. Create a bot with @BotFather and run `npm run cli -- secret set TELEGRAM_BOT_TOKEN`.
2. Get the owner's numeric user ID (e.g. from @userinfobot) and put it in `TELEGRAM_OPERATOR_USER_ID`.
3. Set `CHANNEL=telegram` and restart.

On Telegram, the owner replies to the PIN prompt with the PIN, and the bot deletes that message the moment it arrives.

## Voice notes

Phone keyboard voice typing works without any setup (Gboard and Samsung support Bangla). For real voice notes:

```
npm run setup -- --only voice
npm run restart
```

This puts [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and the "small" speech model (about 470 MB, checksum-verified) in `tools/whisper`, and installs ffmpeg (winget, Homebrew; on Linux `sudo apt install ffmpeg` first). The service then starts and stops whisper itself, listening on this PC only, so audio never leaves it. Each transcript is echoed back as "I heard: …" first.

- `WHISPER_LANG`: `auto` (default), or `bn` / `en` if short Bangla notes get detected as the wrong language.
- A voice note of 15 seconds takes a few seconds on a normal CPU.
- Already run your own whisper server? Set `WHISPER_URL` instead.

## Browser control

```
npm run setup -- --only browser
npm run restart
```

Opens the Claude in Chrome extension page. Add the extension and sign in with the same Claude account as this PC, then setup sets `OPERATOR_BROWSER=true`. The operator then drives the real Chrome profile (logged-in sites included), so every browser action asks the owner for approval. Chrome must be open for it to work. Turn it off with `OPERATOR_BROWSER=false` in `.env`.

## Quarterly check

Re-read Meta's WhatsApp Business Solution Terms every quarter. If they tighten against internal AI tools, switch to Telegram.

## Uninstall

| Command | What it does |
|---|---|
| `uninstall.cmd` (same as `npm run uninstall`) | Stops the service and removes the scheduled tasks. Clears the webhook override; the app stays subscribed, so whatsapp-mcp keeps working. Deletes the `wa-operator:*` secrets. Keeps `.env` and `data/`, so `install.cmd` brings everything back. |
| `uninstall.cmd --purge` | Also deletes `data/` (PIN, history, tool tiers), `logs/`, `dist/` and `node_modules`. `.env` is never deleted. |
| `--keep-secrets` | Keeps the secrets, so a reinstall is quick. |
| `--yes` | Runs without asking. |

Not undone, change these by hand if needed:
- Sleep settings: `powercfg /change standby-timeout-ac 30`
- Autologon: open Sysinternals Autologon and click Disable
- The PIN Flow and the template stay in WhatsApp Manager

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run status` | Whether autostart is on and the service answers |
| `npm start` / `npm stop` | Start / stop everything (service, tunnel, lock-at-logon). `npm stop` also turns off autostart, so nothing comes back after a reboot until `npm start` |
| `npm run restart` | Rebuild and restart (after changing code, `.env` or `config/mcp.json`) |
| `npm run logs` | Follow the log |
| `npm run doctor` | Check login, service, tunnel, webhook, MCP servers, PIN |
| `npm run cli -- <cmd>` | PC controls: `set-pin`, `enable`, `tiers`, `secret` … |
| `npm run dev` | Run in this window (stops when it closes) |
| `npm run check` | Typecheck, lint and test |

Install / remove: `install.cmd` / `uninstall.cmd` on Windows, `./install.sh` / `npm run uninstall` on macOS and Linux (or `npm run setup` / `npm run uninstall`).
