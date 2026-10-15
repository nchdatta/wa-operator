# Test bugs / issues (to fix later)

Test run started 2026-10-15. Persona: software company owner (NexaSoft), English with typos + Bangla/Banglish.

## Carried over from previous run
- [ ] Ledger lost noon entries (12:12 rice, Rahim 700 due missing; only evening entries exist).
- [ ] "check my last linkedin post" → said "no posts" (likely wrong page).
- [ ] Owner PIN was exposed in a test session → owner must run `wa-operator set-pin`.

## Found in this run
- [ ] **Messages sent while locked are replayed after unlock, each answered separately** (3 "hi" replies after PIN). Should merge or answer only the latest.
- [ ] **Business type is hardcoded as a shop.** "wat can u do" / "hlp" talk about rice sales, suppliers, Karim dues even for a software company. Help examples should follow the owner's business (memory) or stay generic.
- [ ] **Typos skip quick words**: "staus", "hlp" go to the AI (slow, different output) instead of /status, /help. Add fuzzy match for short single-word commands.
- [ ] "staus" (via AI) shows a sales summary, not the status screen — inconsistent with "status".
- [ ] "wats going on?" reply mentions an old failed YouTube job from a previous day; stale context.
- [ ] Weather answer has a long list of source URLs — too long for phone; should be 1–2 lines.
- [ ] "working days left" answer guesses two work weeks and adds a holiday caveat — verbose; should ask once and remember.
- [ ] Browser via Playwright extension (dev profile) hangs with no message to owner when the extension needs connection approval. Needs a token (`PLAYWRIGHT_MCP_EXTENSION_TOKEN`) or a timeout + "open Chrome and allow" message.
- [x] **FIXED: "stop" while an approval card was open only answered "No" to that card; the job went on to the next card.** "stop"/"থামো" now stop the job and answer the card with No.
- [x] FIXED: emojis removed from approval cards and most bot messages (kept: ⏰ reminders, 🔒 locked, reactions).
- [ ] **Bulk actions = one card per item** ("delete all promo mails" asked per thread). Should be one card: "Move 33 promo emails to Trash?".
- [ ] **Card shows tool name, not the action**: "Gmail: send message" (no To / subject), "Gmail: trash thread" (no which/how many). Needs plain text e.g. "Send email to jhon@acmecorp.test: Delivery Delay Notice".
- [ ] **Browser job silently vanished** (Google search after restart): no reply, `tasks` says nothing running.
- [ ] "stp" (typo) not mapped to stop; AI replied "Nothing is running" while a job was running.
- [ ] Restart notice says "PC restarted during …" but it was only the app restarting.
- [ ] Money totals include 2,080 from old shop test data; Bluebird 40k payment not counted as money received today ("ajke koto taka aslo").
- [ ] Banglish messages ("ajke koto taka aslo", "kal sokal 9 tay…") answered in English. Decide: reply in Banglish/Bangla?
- [ ] Bot mixes two businesses: memory has "GISL, Uttara" plus NexaSoft; shop data (Karim 200 due) shows in software-company answers.
- [ ] Log noise: "some MCP servers did not connect" warning on every run (plugin:data:* servers). Log once per start.
- [x] FIXED: Bangla "কাজগুলা দেখাও" and typos (stp, staus, hlp, taks, remindrs, cancle 2) now map to quick words. Before, AI answered "no tasks" while a job was running.
- [ ] Task list shows as "1. task" but the running/waiting difference is now only "(waiting)"; check it reads well on the phone.
- [ ] Progress message is technical: "Using whatsapp-out (send file)…". Should be "Sending the file…".
- [ ] File send: summary text sent twice (file caption + final reply).
- [ ] "make proposal for acme mobile app" asked 4 questions at once (rule says at most one; better: draft with sensible defaults, then ask).
- [ ] Bangla help ("সাহায্য") returns the English help text with shop examples.
- [ ] Approval cards are in English even in a Bangla conversation ("OK? / Gmail: send message").
- [ ] Bangla amount "দেড় লাখ" worked, but bot assumed a NEW Acme payment and said it was added separately — good, but it should confirm when a similar entry exists the same day.
- [ ] Without browser, GitHub trending fell back to web search with stale data and a long source list; it should say "the browser isn't connected" in one line.
- [ ] Memory lists old "Rahman Store oil supplier" (shop test data) next to NexaSoft — clean old test memory.

## Browser (Playwright, dev profile) — after token added
- [x] Works: Google search (~90 s), ChatGPT banner (~4 min, PNG sent), Product Hunt top 5, close browser, LinkedIn (dev account has no posts — correct).
- [ ] Progress messages are technical / repetitive: "Reading page-2026-10-15T04-55-31-296Z.yml…", "Searching files…" ↔ "Working in the browser…" alternating, "Running a command…". Should be one friendly line, updated rarely.
- [ ] Screenshot send to phone failed ("photo upload failed on the phone link") — Playwright screenshots aren't reaching whatsapp-out send_file.
- [ ] Playwright writes page snapshots into Documents\.playwright-mcp\ — clutters the owner's Documents. Set `--output-dir` to the app's temp folder.
- [ ] Dev profile not logged in to Facebook → posting can't be tested; owner must log in once in that profile.
- [ ] Browser tasks are slow (1.5–4 min). Consider a "Still working, ~2 min" note instead of many progress lines.
