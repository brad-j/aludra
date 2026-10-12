# Plan

aludra is a coding agent you reach from your phone and your desk: Pi Durable on egwene, running Claude Opus 5.5 through `pi-claude-bridge` on Brad's Claude subscription, with a TanStack Start web app over Tailscale. Many sessions, each in a project directory, that survive restarts. It's named for the Illuminator who invents things.

The inspiration is Mario Zechner's Pi Durable phone app (x.com/badlogicgames/status/2109413968552820840, 2026-10-11): sessions grouped by machine and directory, steer and stop, a model and context footer, and codemode workflows that fan out subagents you can open and steer.

## Decisions

- **Runs on egwene.** The working copies, the Claude Code login, the toolchain, git identity and SSH keys are all there, and egwene runs around the clock (sleep, suspend and hibernate are masked). Edits land in `~/westwood` directly.
- **Subscription, not API.** The model provider is `pi-claude-bridge`, which drives Claude Code through the Agent SDK and uses the subscription quota (its README, line 11). Anthropic announced and then withdrew a billing change for Agent SDK tools; if it returns, this breaks, and so does terminal pi. Opus at API prices isn't affordable for this.
- **Pi Durable 1.1.0**, pinned, with the bridge pinned beside it. The glue depends on bridge internals (see Spike findings), so upgrade either one deliberately.
- **Workspaces in config.** One settings file, checked at start:

  ```json
  {
    "workspaces": [
      { "name": "egwene", "roots": ["~/westwood/Projects/*/*", "~/westwood/Personal/*"] }
    ],
    "model": { "provider": "claude-bridge", "id": "claude-opus-5-5", "thinking": "high" }
  }
  ```

  Each root is a glob; each match is a project in the picker. Not `Writing/` or `Notes/`. Every session stores its workspace and directory, and the UI groups by them. Only the local workspace works at first; a remote one later is a Pi Durable remote execution environment and a new entry here.
- **Permissions: open, with a short exception list.** Inside a project everything runs without asking: edits, builds, tests, installs, commits. Two things wait for one tap from a push: `git push`, and anything reaching homelab hosts (`ssh`, `scp`, `rsync` to think-1, think-2, monitor-01), because egwene's keys reach them. Secrets stay unreadable through a port of `~/.pi/agent/extensions/protected-path-gate.ts` (pi extensions don't load in Pi Durable). Approvals are a `beforeTool` hook; the gate wraps the four tools instead, because ending a run on the second block takes a tool result (`control.terminate`), which a hook can't return. Both read shell commands as text, so they're best effort.
- **TanStack Start, as an installable PWA.** One app for phone and desk. The mobile feel is the priority. The Pi Durable host is a separate long-lived process that owns the SQLite file; the app talks to it over a WebSocket, so Vite's reloads never touch durable work, and a native client could later use the same API. Native (share sheet into ideas, Live Activities) is a possible small companion later, not a second full app.
- **Sessions are separate from terminal pi sessions** for now. Different storage formats.
- **No spend tracking.** Cost is $0 on the subscription. The UI shows context used and the subscription windows instead, from the bridge's `rate_limit_event` (`five_hour`, `resetsAt`, `overageStatus`).
- **Monitoring:** a systemd user service with `Restart=always`, `aludra doctor`, and a push when a run fails. Hooking egwene into the homelab's failed-unit ntfy alerts or a monitor-01 health check waits until it's missed.
- **Backups:** egwene has none in the homelab setup. Losing the database loses session history, not code. Accepted for now.

## Architecture

- **Host** (`aludra serve`): one Node process, a systemd user service. Pi Durable `Harness` over SQLite in `~/.local/share/aludra/`. `harness.resume()` at start.
- **Bridge provider** (`src/bridge.ts`): loads the bridge, wraps its `streamSimple` as a pi-ai provider, applies the two fixes from the spike. `pi-claude-bridge`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` become pinned dependencies (the last two are the bridge's peers).
- **Sessions:** one Pi Durable conversation each, `cwd` set to the project directory, model and thinking per session, default Opus 5.5 high.
- **Extensions:** Pi Durable's `CodingTools` (read, write, edit, bash) with a `NodeExecutionEnv` per call from the conversation's `cwd`; a project-context section that loads AGENTS.md or CLAUDE.md and skills (`~/.pi/agent/skills` and the project's); the permissions hook.
- **Ideas:** a session with a draft first message, not yet sent, kept in a Pi Durable document and filed under its project. Starting it submits the draft.
- **CLI:** talks to the host over a Unix socket in the data directory, one JSON object per line (gaidin's pattern). The app's API below is separate.
- **API:** loopback HTTP and WebSocket, exposed through Tailscale Serve, trusting its identity header the way gaidin's web view does (`gaidin/docs/security.md`). Live state from `conversation.watch()`.
- **App:** TanStack Start, built as a PWA (manifest, service worker, Web Push, safe areas). Gaidin's `src/push.ts` and `web/sw.js` are the starting point for push.

## Milestones

1. **Host and CLI.** Done 2026-10-11; see "Milestone 1 findings". `aludra ask --project <name> "..."`, `aludra watch`, `aludra doctor`, sessions per project, recovery after `kill -9`. Settle what the spike left open:
   - two conversations running at once through the bridge;
   - compaction (Pi Durable calls the provider for the summary; the bridge's compaction hooks never fire here);
   - the bridge's `process.cwd()`: it uses the host's directory for Claude Code's side of every session (session files, context). Tools already run in each conversation's own directory.
   - the permissions hook and the protected-path port.
   Tests against a faux model; one live check run by hand.
2. **Design pass.** Done 2026-10-11: Brad approved the second prototype, redone toward his Pi Mobile references (`design/prototype.html`, see "Milestone 2 design"). The app follows it and `design/tokens.css`. Hallmark, before any app code. A clickable single-file prototype of the home screen, a live session, a session's changes, and idea capture, judged on Brad's phone. Brief in [design-brief.md](design-brief.md).
3. **App.** Done 2026-10-11 (see "Milestone 3"); running on Brad's phone over Tailscale. TanStack Start on the host's API: sessions, transcript, steer, stop, follow-up, new session, model and thinking. Checked with Playwright at phone sizes and on the phone over Tailscale.
4. **Ideas, approvals and push.** Done 2026-10-11 (see "Milestone 4"); notifications reach Brad's iPhone.
5. **Changes view:** the session's diff since it started. Built 2026-10-11 (see "Milestone 5").
6. **Subagents:** deferred 2026-10-12. An `agent` tool on Pi Durable's documented subagent pattern (README, "Abort and Subagents"), children shown under the call. Brad's terminal pi has no subagents either, Opus 5.5 has a 1M window with compaction working, and each child spends the same five-hour window, which aludra can't show yet. Mario's durable codemode isn't in Pi Durable 1.1.0; script fan-out waits for it. Before this: the systemd unit for the host, the subscription meter, and a live run of the app on the real bridge.

Later, maybe: Slack (a channel per project, a thread per session), voice, a native companion, other workspaces.

## Spike findings (2026-10-11)

Both scripts are in [`../spike/`](../spike/). They were run from `/tmp` with gaidin's `node_modules` symlinked in, so their paths need adjusting to run again.

**Pi SDK (`spike/sdk.mjs`).** `createAgentSession()` in a custom process loads Brad's settings, packages and extensions, including the bridge. It starts on `anthropic/claude-opus-4-8` rather than the configured `claude-bridge` default, probably because the default is resolved before the bridge registers its provider; `session.setModel()` afterwards fixes it. A one-line prompt on `claude-bridge/claude-opus-5-5` answered with cost $0.

**Pi Durable (`spike/durable.mjs`).** Works end to end, including a crash:

- The bridge loads through jiti with a stand-in `ExtensionAPI` that keeps the `registerProvider` config and ignores the rest. jiti aliases point `@earendil-works/pi-ai` (and `/compat`) at the same pi-ai 1.1.0 Pi Durable uses.
- The provider wraps the bridge's `streamSimple`. Pi Durable passes a stable per-conversation `sessionId` (its `pi.provider` document), which is the key the bridge uses for its state.
- **Signal fix.** Pi Durable aborts each request's signal when that request is done. The bridge keeps one Claude Code query alive across tool calls and ties it to the first signal, so the run died with "Operation aborted" after the first tool call. The wrapper keeps one `AbortController` per session and forwards an abort only while a stream is running.
- **Restart fix.** After a restart the bridge has no live query; a transcript ending in a tool result takes its "orphaned tool result after abort" path and ends the turn empty. On the first request per session in a process, if the last message is a tool result, the wrapper appends a short user note to that request only (not stored), which sends the bridge down its rebuild path ("Case 2": it writes Claude Code's session from the transcript and resumes).
- **Result.** A three-step bash task killed with `kill -9` during step 1's `sleep 15` resumed on restart: the model saw the interrupted call, checked state, ran steps 2 and 3 and answered correctly. The bridge log showed the `five_hour` rate-limit window, so it ran on the subscription.
- **Classifier false positive.** One recovery request was refused by Opus 5.5's safeguards as `[cyber]`. The test read a file named `secret.txt` and the note said "The agent process restarted". With `notes.txt` and "(Continuing where we left off.)" it passed. These refusals can happen in real use; the app must show them plainly as their own failure, with the request ID.
- `CLAUDE_BRIDGE_DEBUG=1` with `CLAUDE_BRIDGE_DEBUG_PATH` gives a detailed log of the bridge's session handling.

## The desk layout (2026-10-12)

The approved design was drawn for the phone, and on a desk it left the header, the transcript and the composer on three different alignments, the composer flat under a rule, and the new-session prompt at the bottom of an empty pane. From 60rem the app has its own layout, and the phone's is unchanged: the header lines up with a 46rem transcript column, the composer is a bordered box, the sidebar is a step lighter with each project's folder group ("Software") instead of its whole path, and a new session puts the prompt high in the pane with the project's ideas under it.

## Milestone 5 (2026-10-11)

- **The starting point:** when a session is created, `src/changes.ts` writes the project's working tree as a git tree through a temporary index (a copy of the real one), so untracked files count and ignored ones don't. The repository's index, branches and refs are untouched; only objects are added. The tree's hash is kept in the session's record, and git keeps unreferenced objects at least two weeks, so a session older than that can lose its starting point after a `git gc`.
- **The changes** are the diff from that tree to a fresh one, limited to the project's directory, so a project inside a bigger repository sees only its own files. They include the session's commits, but not what was already uncommitted when it started. Projects outside git, and sessions from before this milestone, say why there's nothing to show.
- **App:** the folder icon in a session's header shows how many files changed, and it and the path open the changes: `+N −M` at the top, files biggest first with an add/delete bar and new, deleted or renamed noted, each opening to its diff. The count is read again as the run moves, at most every three seconds, since each read snapshots the files.
- **API:** `GET /api/sessions/:id/changes`, and `/changes/diff?path=` for a file in those changes only.
- **Tests:** 4 against real temporary repositories (what counts, a project inside a bigger repository, outside git, git's `-z` output), and 2 e2e checks with a scratch repository the e2e setup creates in `e2e/results`.

## Milestone 4 (2026-10-11)

- **Ideas** are first messages kept for later, in a session document (`aludra.ideas`), filed under their project. The new-session composer saves one ("Idea"); they show under their project in the drawer and on the new-session screen, and Start runs one as a session in its project. Tapping one shows it whole, with Start and Delete.
- **Push** is gaidin's Web Push (`src/push.ts`: RFC 8291 encryption, VAPID signing with a key made on first start in the data directory). Each device records the app's address it signed up from, which push services get as the contact. Notifications go out when a call waits for approval (after 2 seconds, if it still waits) and when a run ends done or failed, detected from the task graph: a session whose generation and tool tasks are gone. Nothing is sent about a session the app is showing on screen; the app tells the host when it's hidden. Tapping one opens the session, with the approval docked above the composer.
- **Approvals** were already answerable in the app (milestone 3). iOS web push has no notification buttons, so Allow and Deny stay in the app, one tap from the notification.
- **Turning it on:** the drawer's foot says whether this device gets notifications, with Turn on, Test and Turn off. On an iPhone only the app added to the Home Screen can get them, which it says.
- **Testing it:** Test sends five seconds after the tap, so the phone can be locked first: iOS shows no banner for the web app on screen, and Do Not Disturb holds notifications too.
- `aludra doctor` checks that the push services are reachable. Tests: 3 for push encryption and signing, 3 more API tests (ideas; approval and run-end notifications, and none for a session on screen), and an e2e test for saving and starting an idea.

## Milestone 3 (2026-10-11)

- **One process.** The host serves the app's API and the built app on `127.0.0.1:8724` (`src/api.ts`); tailscale serve is the way in. TanStack Start runs in SPA mode: the UI is all client-side over the WebSocket, so SSR would only add a second service. `pnpm build` writes `dist/client`, which the host reads at start, so a new build needs a host restart. `pnpm dev` runs Vite on `127.0.0.1:8725` and proxies `/api` to a running host with the Tailscale login added.
- **Identity:** as in gaidin, every request and the WebSocket upgrade need `Tailscale-User-Login` equal to `api.user`, and POSTs must be same-origin JSON. Without `api.user` in `aludra.json` the API doesn't start.
- **CSP:** only the app's own scripts run. The shell's inline scripts are allowed by hash, computed at start. TanStack's shell puts a NUL in one, which browsers hash as U+FFFD, so the host does too.
- **API:** `GET /api/bootstrap`; `POST` to start a session, send a steer or follow-up, stop, change model and thinking, withdraw a queued message, and answer an approval. `WS /api/live` sends the sessions list and the followed session's transcript as items (user, answer, call, failure, compacted), resending only from the first item that changed, plus its meta (state, model, thinking, context, queue, approval, retry). `src/transcript.ts` builds the items from Pi Durable's conversation view. Model choices are `model.choices` in the settings.
- **App:** the approved design (`app/`, styles from `design/prototype.html`). Markdown uses gaidin's DOM-building renderer, fonts are self-hosted Fira (`@fontsource`), and the service worker only shows an offline page. Approvals are answerable already, since a waiting session would otherwise look stuck. Ideas, the changes view and the subscription meter wait for milestones 4 and 5.
- **Tests:** `test/api.test.ts` (7) covers the API; `pnpm e2e` (Playwright, 10 checks) runs the app against the faux host at iPhone size and on the desk, and checks 320 to 1280 px for overflow and wrapped buttons. WebKit needs Ubuntu system libraries this machine lacks, so the phone runs are Chromium; the phone itself is the Safari-engine check.
- **The way in:** `https://aludra.<tailnet>.ts.net/`, served by aludra's own Tailscale node: a second `tailscaled` on egwene, run as Brad's user in userspace mode (`deploy/aludra-tailscale.service`, state in `~/.local/share/aludra/tailscale`). It keeps egwene's own Tailscale untouched and needs no root to serve; a Tailscale Service (`svc:aludra`) would have meant tagging egwene. `aludra doctor` checks that node's serve config.
- **Open:** the subscription meter needs the bridge's structured rate-limit data (see milestone 1 findings). Keyboard handling in the installed PWA is unchecked until it's on the phone.

## Milestone 2 design (2026-10-11)

`design/prototype.html` is one self-contained page with sample data; `design/tokens.css` holds its tokens for the app. The first pass (a session index with a starlight bloom) was redone the same day toward Brad's reference screenshots of Mario Zechner's Pi Mobile: the transcript is the screen, chrome is a hairline and a few icons. Every text colour meets WCAG AA contrast, and a Playwright pass found no overflow or wrapped buttons at 320, 375, 414, 768 and 1280 px.

- **Look:** near-black, nearly neutral paper (`oklch(16.5% 0.003 260)`); colour only in syntax highlighting, state marks and one blue-white accent. Fira Sans (humanist) at 17px for prose, Fira Code for commands, paths, calls and code.
- **Session screen:** a header with the menu, the title, the machine and path in mono (dotted underline; tapping it opens the changes), a files icon with the changed-file count, and a menu. User messages are right-aligned blocks; answers are full-width Markdown with a copy button. Each tool call is a mono row (mark, tool, a dotted-underlined argument that opens its output, code or diff, duration); a finished round folds into one line ("read 4 files · ran 2 commands · edited 3"). The running command is a code block with a spinner and a fixed-height tail of its output, so streaming never moves the page. A ↓ button appears when scrolled up.
- **Composer:** flat under a hairline. `+` opens the session menu, the Steer/Queue label toggles how a message is delivered, the model, thinking and context sit beside it, and Stop shows while a run goes (Send appears once there's text). Queued messages wait above it; stopping drops them. An approval docks above it.
- **Sessions:** a drawer from the left (a column on the desk), grouped by machine and directory, most urgent project first, each project name larger and in the accent with a hairline between groups. Rows show a mark (spinner, amber diamond, red crossed circle, check, square), title, latest activity and age; ideas sit under their project with Start. The five-hour and weekly windows are a thin meter at the foot of the drawer. A phone opens on the drawer.
- **New session:** a screen whose path picks the project; the composer starts the session or saves the text as an idea.
- **Failures as themselves:** a safeguard refusal (with the request ID and Copy ID), a test failure and a bridge error each get their own title, detail and next actions.
- **Changes:** totals at the top, files ordered by size with an add/delete bar, each opening to its diff.
- **Phone details:** 16px+ inputs, safe areas, a `visualViewport` fix so the composer and sheets sit above the iOS keyboard, contained scrolling.

Approved by Brad on 2026-10-11, after project names in the drawer were made larger and accent-coloured. Brad checked it in Chrome on iOS, which runs on WebKit like Safari, and it looked right. Milestone 3 still checks the keyboard handling in the installed PWA, which runs standalone rather than in a browser tab. Subagents (Pi Mobile's agent count in the header) wait for milestone 6.

## Milestone 1 findings (2026-10-11)

All the bridge glue is in `src/bridge.ts`, and each fix has a test that fails without it (`test/bridge.test.ts`). `scripts/live-check.ts` runs the real bridge and passed: two sessions at once, compaction, `kill -9` recovery. Rerun it after upgrading Pi Durable or the bridge; `aludra doctor` fails when either differs from the pinned version.

- **Two conversations at once** work without changes. The bridge gives a second concurrent query its own query context (built for subagents in one process) and keys its Claude Code session mirror by Pi Durable's per-conversation `sessionId`. Live: both answered correctly in 3 seconds.
- **Compaction** needed a fix. Pi Durable sends its summary with `cacheRetention: "none"`, which the bridge routes to a one-off Claude Code process, so the summary itself works. But the next request would either resume the old, uncompacted Claude Code session or start one with no history, because pi's `session_compact` event never fires here. The stand-in `ExtensionAPI` now keeps the bridge's `pi.on` handlers, and the wrapper calls its `session_compact` handler when a conversation's first message changes (compaction or reset). Live: the bridge rebuilt the session from the summary and the session still recalled the detail.
- **The working directory:** the bridge reads `process.cwd()` synchronously inside `streamSimple` (and its summary path) before spawning Claude Code, so the wrapper changes into the conversation's directory around that call and back. A `beforeRequest` hook records each conversation's `cwd` under its provider `sessionId`. Claude Code's environment section and session files are now per project, so sessions also appear in `claude --resume` for that project.
- **The system prompt:** the bridge sends only a system prompt it recorded from pi's events, and fails the turn otherwise. The spike passed because it had no sections. The wrapper records each request's prompt in the bridge's shared prompt-capture registry as a custom prompt, so Claude Code gets all of it after its own preset. Project context and skills use pi-coding-agent's own loaders (`loadProjectContextFiles`, `loadSkills`); `~/.agents/skills` isn't among their defaults.
- **Restarts:** the recovery note now goes on any request that ends in a tool result the bridge has no parked query for, not only the first request after a restart. Stopping a run between requests also ends that session's Claude Code query.
- **Rate limits:** the bridge's `rate_limit_event` reaches aludra only as a notice text (the stand-in fires its `session_start` with a `ui.notify`). The structured `five_hour` and `resetsAt` fields the subscription meter needs are only in its debug log; milestone 3 needs another way in.
- The bridge registers its provider once per process, so `loadBridge` loads it once.
- Session ids are Pi Durable conversation ids, so they start at 7, not 1.
- `deploy/aludra.service` is written but not installed.
