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
- **Permissions: open, with a short exception list.** Inside a project everything runs without asking: edits, builds, tests, installs, commits. Two things wait for one tap from a push: `git push`, and anything reaching homelab hosts (`ssh`, `scp`, `rsync` to think-1, think-2, monitor-01), because egwene's keys reach them. Secrets stay unreadable through a port of `~/.pi/agent/extensions/protected-path-gate.ts` (pi extensions don't load in Pi Durable). Approvals are a `beforeTool` hook; the gate wraps the four tools instead, because ending a run on the second block takes a tool result (`control.terminate`), which a hook can't return. Both read shell commands as text, so they're best effort. Since 2026-10-19 amyrlin can approve one always, which allows its summary (`git push`, `ssh to think-1`) for that session only and can be taken back; a rule wider than a session would turn the gate off without anyone seeing it.
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
- **Mac app:** the amyrlin Mac app's protocol v1 at `/amyrlin` on the same server (see "The amyrlin Mac app").
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

## Release: aludra on any machine (2026-10-13)

Brad decided to make aludra installable on any of his machines (Linux or macOS), each added to the amyrlin Mac app. First framed as a public release; on 2026-10-13 he chose to keep both repositories private and install locally, with no npm, no Apple signing and no license for now. Nothing technical stops a private setup: a machine with access to the repository builds and installs from a checkout. The amyrlin name and the Flame of Tar Valon stay while it's private; before any public release the flame (a Wheel of Time symbol) should be replaced with an original mark. Phases: (1) a general host, (2) setup, (3) the Mac app's first-run help and Gatekeeper note.

Decisions:

- **Models through the user's own Claude Code**, after T3 Code. Anthropic's terms ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) forbid apps that offer Claude.ai login or handle Claude credentials, and allow "an end user ... signing in to the unmodified Claude Code binary with their own Claude subscription". So aludra never signs anyone in: the user installs Claude Code and runs `claude auth login`, and the bridge runs that binary. pi-claude-bridge stays the provider; Brad accepted that it goes further than T3 Code (pi's tools and prompt through SDK options) and that Anthropic may change billing. API keys through pi-ai may come later as a second provider. Docs may say aludra "runs Claude Code", and use no Claude or Anthropic marks.
- **Phase 1, done on the `release-host` branch:**
  - Settings in `~/.config/aludra/config.json` (or `$XDG_CONFIG_HOME`), data in `~/Library/Application Support/aludra` on macOS and `$XDG_DATA_HOME/aludra` elsewhere. No built-in workspaces: `serve` refuses to start without one and says how to name it. No approval hosts by default; `git push` still waits.
  - `api.users`, a list of Tailscale logins, replaces `api.user`; an old `api.user` is an error rather than a quiet API shutdown. Each listed login sees itself in bootstrap and on the Mac.
  - `claude.path` (default `claude` on PATH) is the binary the bridge runs, not the Agent SDK's bundled copy. The bridge reads that only from `claude-bridge.json` in pi's agent directory, so it gets its own: `bridge/` in the data directory, reached by aliasing its pi-coding-agent import to a module there that answers `getAgentDir()`. Terminal pi's bridge settings are left alone. A live run from the installed package went through a logging wrapper at `claude.path`.
  - A package: the host builds to `dist/host` (Node won't strip types inside `node_modules`) and finds `dist/client` from its package root. React, TanStack and the fonts are dev dependencies. Pi's lockstep packages (chord, pi-agent-core, pi-ai, pi-codemode, pi-coding-agent, pi-durable, pi-mcp, pi-telemetry, pi-tui) are all pinned at 1.1.0: an npm install without the lockfile took pi-codemode 1.2.0, which satisfies 1.1's `^1.1.0` and breaks it. `npm install -g` of the packed tarball, then `doctor`, `serve` and `ask`, work on macOS and on egwene.
  - macOS: a project reached through a symlink (`/var` is `/private/var`) lost its changes view; fixed, with a test. Doctor skips the systemd check where there's none.
  - The model, the app and the tests speak of the user and listed hosts.
- **Phase 2, setup, done and merged:**
  - `aludra init` writes the settings file. It guesses project roots from where git repositories are under the home directory (each repository's parent with `/*`; sibling parents folded into `/*/*`; a root only if at least two repositories and at least half its matches are repositories, and none holds a repository below it), and the login from `tailscale status`. `--root`, `--user`, `--name` and `--yes` answer without asking. On the Mac it guessed `~/1-code/*`; on egwene `~/westwood/Projects/*/*`.
  - `aludra service install | uninstall | status`: a launchd agent (`io.bradjohnson.aludra`, log in `~/Library/Logs/aludra/`) or a systemd user unit (`aludra.service`), running this Node and this aludra with the installing shell's PATH (sessions run commands with it), plus Node's and Claude Code's directories. Installing again rewrites and restarts it. It refuses while an `aludra serve` runs outside it. A unit linked from a checkout is replaced rather than written through, even dangling (Node's `rmSync` leaves a dangling link in place, so `unlinkSync`).
  - Doctor reads service state on both, warns when the unit names another aludra, Node or settings file (its PATH aside), when systemd won't outlive logout, and prints the tailscale command and the app's addresses. `src/tailscale.ts` uses aludra's own node (egwene's `deploy/aludra-tailscale.service`) when its socket is in the data directory.
  - `scripts/install.sh` builds, packs and installs globally with npm, then reinstalls the service if there is one. A README.
  - The launchd agent and the systemd unit were each installed under a test name, served the API, and uninstalled cleanly.
- **Egwene moved, 2026-10-13:** `~/.config/aludra/config.json` with the old defaults written out (workspace `egwene` with both roots, Brad's login, approval hosts think-1, think-2 and monitor-01); `scripts/install.sh` run with the user manager's PATH (`systemctl --user show-environment`), which has more than an SSH shell's (rustup, perl); the unit linked from `deploy/` replaced by the written one, with all sessions idle. The checkout stays for development; the host runs the installed package. Data directory unchanged.
- **Phase 3, the Mac app, done 2026-10-13** (amyrlin `2af8d0ea`): with no machines its window shows aludra's install commands and adds one; a machine that can't connect says why and what to run under its name, read from the WebSocket upgrade's HTTP status (403: the login isn't in `api.users`; 502: nothing behind tailscale serve) or the network error. Its README covers setup and opening the ad hoc signed app on another Mac (Control-click Open no longer bypasses Gatekeeper; Privacy & Security's Open Anyway, or removing the quarantine attribute).
- **After the release work, 2026-10-13:**
  - **Backups:** the running host copies its database with SQLite's online backup once a day and keeps seven, in `backups/` in the data directory or `backup.dir`; owner-only files, named by their time. `aludra backup` makes one now; doctor says how old the newest is. Off-machine copies need `backup.dir` on another disk or a synced folder; where egwene's go is Brad's call.
  - **Picked project colors,** for hashed hues that clash: name to hue index in `aludra.colors`; `projects.setColor` and `host.projectColors` on the Mac (a Color menu on a project's row), `POST /api/projects/color` and a `colors` event on the web, which shows them but has no picker yet.
  - **Renaming:** `conversations.rename` and `POST /api/sessions/:id/title`; the Mac's session menu and a double-click on the header, the web's session menu. The open session's meta follows its record, so a later run can't put the old title back.
  - **Images:** messages carry PNG, JPEG, GIF or WebP (8 at most, 5 MB each, sniffed), scaled to 1568 px by the apps; transcripts carry where each is, and the apps fetch the bytes (`GET /api/sessions/:id/images/…`, `conversation.image`). The bridge passes them to Claude Code: a live run on the Mac named a blue square's color. Tool results' images (a screenshot read) show too.
  - `aludra service install` over a running launchd agent waits for bootout to finish; launchd's error 5 had left the Mac's host stopped after an update.
- **Docs, 2026-10-13:** `docs/` now describes aludra as it stands, apart from this plan's history: setup, configuration, using it, the CLI, security, operations, architecture, the API and development, indexed from the README. The README keeps the quick start; restoring backups moved to `docs/operations.md`.
- **CI** isn't set up: private repositories get 2,000 Actions minutes a month and macOS minutes count ten times, so if it comes, Linux only.

## OpenAI on a ChatGPT sign-in (2026-10-13)

Brad asked for a second provider on his ChatGPT plan, with OpenRouter or OrcaRouter maybe later. Built on the `chatgpt-sign-in` branch; not yet run against a real sign-in.

- **Sign in with ChatGPT, not the Codex client.** pi-ai 1.1.0 has two ChatGPT logins. `openai-codex` borrows the Codex CLI's client ID against `chatgpt.com/backend-api`, the same kind of reuse aludra avoids for Claude. `openai` uses OpenAI's own Sign in with ChatGPT ([developers.openai.com/siwc](https://developers.openai.com/siwc/token-sharing-open-source)), meant for open-source apps on the user's machine: a client registered per user, a stable host ID per installation, requests to `api.openai.com` on the plan. aludra uses that one. Its preview rules (`store: false`, no `temperature` or `max_output_tokens`) are pi-ai's to follow, and it does when the token is a ChatGPT one.
- **The routers can't carry the plan.** OpenRouter's and OrcaRouter's bring-your-own-key take API keys billed per token, and a ChatGPT sign-in is for the user's own app talking to OpenAI. Either would be a separate pay-per-token provider: OpenRouter is in pi-ai already; OrcaRouter is OpenAI-compatible and would need a small custom provider. Paid providers would also reverse "No spend tracking": a session's cost would have to show.
- **Settings:** `model.choices` entries are `provider/id` or a bare ID of `model.provider` (claude-bridge unless set), and `model.id` may name its provider too; existing files mean what they did. Choice IDs must be unique, since the apps pick by ID. A provider is loaded only when a choice uses it, so a machine without Claude Code can run OpenAI alone.
- **Credentials:** `credentials.json` in the data directory (`src/credentials.ts`), a pi-ai `CredentialStore` read afresh for every request, with a lock file between the CLI and the host. The protected-path rules already cover the name. `device-id` beside it is the installation's host ID.
- **CLI:** `aludra login openai` runs pi-ai's flow with `agentName: "aludra"` (callback on `127.0.0.1:1455`, or a pasted redirect URL over SSH), then lists the account's models from `GET /v1/models` as choices. `aludra logout openai`. Doctor's `openai` line checks the sign-in and that the account offers each choice; `claude` is skipped when no choice is Claude.
- **Switching provider mid-session** needs no glue: Pi Durable's transcript is provider-neutral, and the bridge rebuilds Claude Code's session when it finds messages it didn't see (its "Case 4", written for provider switches).
- **Not done:** the app's picker lists every choice in one list, without provider headings; the subscription meter stays Claude-only. The live check is Brad's: sign in on egwene, add a choice, run a session on it, and switch one session Claude → GPT → Claude.

## The terminal (2026-10-13)

Brad wanted aludra to look good in a terminal too, without it becoming a second way to drive sessions for now.

- **`aludra sessions`** lays sessions out as the drawer does: grouped by project, the project that most needs you first, the app's state marks (◆ ◐ ⊘ □ ✓ ·), project colors (from `src/project-colors.ts`, now shared by the app, the CLI and amyrlin's rules) and the latest activity under each title. The host sends summaries as data on a `listing` request; an older host ignores it and sends the old lines.
- **`aludra` with no command** opens a read-only terminal UI on pi-tui: the session tree on the left, the selected session's transcript on the right following its output, and its state, model and context at the foot. It's a client of the same live feed as the web app (`src/live.ts`, split out of `src/api.ts`), over a `live` request that keeps the CLI's socket open. Arrow keys pick a session; PgUp, PgDn and the wheel scroll; it reconnects when the host restarts. An older host is told apart from a stopped one and the UI says to update it.
- **Not yet:** typing in it (follow-ups, steer, stop, approvals), new sessions, ideas and the changes view. Those were phases 3 and 4 of the plan Brad was offered; he chose read-only for now.

## Session titles (2026-10-13)

Titles were the first line of the first message cut at 80 characters, which says little when a message opens with "A couple of things…". Now a model writes one, as Claude Code and ChatGPT do.

- **When:** once, when a session's first message is submitted, in the background; the first line shows until then. Every session, short prompts too (Brad's call).
- **Which model:** Claude Haiku 5.5 through the bridge if it's loaded, else the cheapest OpenAI model in `model.choices`, else the default model; each tried in turn. A one-off request (`cacheRetention: "none"`) runs in its own Claude Code process with no tools, so no session is touched. Live through the bridge: about a second each, on the subscription.
- **Renames win:** `titled` on the session record says whether a model or the user wrote it; a model's title never replaces a user's, even one that arrives after the rename.
- **Older sessions:** `aludra retitle` names those still showing their first line, skipping ones renamed before `titled` existed (their title isn't the first line). Brad asked for it to be run once over egwene's sessions.
- Rejected: the agent titling itself through a tool (a turn on the big model, and it may not), smarter truncation, and retitling as a session goes on.

## Any model, and OpenRouter (2026-10-13)

Brad asked for OpenRouter, signed in through the browser, and asked why models had to be listed in the settings to be picked. They don't any more.

- **Any model:** the pickers list `model.choices` as pins, then search every model of every provider the machine is signed in to (`src/catalog.ts`): the bridge's, the ones the ChatGPT account offers, and OpenRouter's catalog (about 400 chat models) with prices per million tokens. The API and amyrlin take `provider/id` for any of them; a pinned ID still works alone. amyrlin's own picker still shows the pins only.
- **OpenRouter:** pi-ai's provider and its OAuth flow, which mints an API key for aludra; `aludra login openrouter`, kept in `credentials.json`. OpenAI and OpenRouter are always loaded now (nothing happens until they're signed in); the bridge still only when a Claude model is pinned.
- **Spend:** this reverses "No spend tracking" for billed providers only. A session's summary carries `cost`, the sum of pi-ai's priced answers from OpenRouter; the web app's model line, the terminal UI and `aludra sessions` show it, and `aludra sessions` adds the calendar month's total. Caps stay on OpenRouter's side (a credit limit on the key). Claude through OpenRouter is at Anthropic's API prices, so it's mainly for models the plans don't have.
- **amyrlin (later the same day):** protocol v1's `spend` prices every model at API rates, plan-paid ones too, so the Mac could show dollars never charged. Summaries now also carry `cost` (charged dollars, billed providers only), and `host.info` and `host.snapshot` carry `monthCost`. A session's cost comes from Pi Durable's usage ledger (it counts compaction summaries); the month's total adds up answers by time, which the ledger can't, so it leaves compaction out.
- **Not checked live:** no OpenRouter account was signed in during the work; the catalog, picking and cost counting are tested with a stored key and recorded answers.

## Archiving (2026-10-13)

A session whose project folder was gone kept its old project group in amyrlin's sidebar, with no way to clear it. amyrlin's protocol v1 already had `conversations.archive` (hide, don't delete, idempotent), and amyrlin hides archived sessions; aludra answered `unsupported`. Now the session record has `archived`; amyrlin's endpoint archives and unarchives and reports it in summaries; the web app archives from the session menu into a folded Archived group at the end of the drawer; `aludra archive`/`unarchive --session ID` do it from the terminal, and `aludra sessions` and the terminal UI leave archived sessions out. There's no delete: archiving is undoable, and nothing else needed one. amyrlin still needs an Archive item in its session menu (its other session offered to add it), and its `docs/protocol.md` still says aludra answers archiving with `unsupported`.

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

## No-project sessions (2026-10-12)

After T3 Code's "no project" threads: a session that isn't about one repository. Its working directory is a scratch directory of its own, `scratch/<id>` in the data directory, set in the commit that creates the conversation (the ID names it); it reads anything else by absolute path, and the protected-path gate and approvals still apply. A `no_project` prompt section (`src/context.ts`) says so and lists where things are on egwene: each workspace's directory, terminal pi's and Claude Code's session histories, and aludra's own database, the ones that exist. It has no changes view and can't hold ideas. The record is `project: "no project"`, `scratch: true`.

- **Web:** "No project" heads the picker; `POST /api/sessions` takes an empty project for it. The drawer groups them under "no project", gray.
- **Mac (`/amyrlin`):** `conversations.create` without a project makes one; its summary has no `project`.
- **Tests:** the web API and the endpoint (pwd runs in the scratch directory; the prompt says it has no project), and an e2e from the picker at both sizes.
- Not done: reading other machines' histories (would need SSH to the homelab hosts, which waits for approval).

## Console redesign (2026-10-12)

With the amyrlin Mac app: chrome in IBM Plex Mono (header, drawer, sheets, composer, buttons), the transcript in IBM Plex Sans, square corners, a tree drawer (▾ project, a guide line down its sessions), your messages as framed blocks with a ❯ and a violet edge, tool calls and folded rounds in boxes, the composer as a box. It's one layer at the end of `app/styles/app.css` ("Console"), so it reads and reverts in one place; the radius tokens are 0. The Mac app also has a tmux-style status line; here the composer's model line carries the same facts. The overflow e2e check passes at every width.

## The Mac app's look (2026-10-12)

Brought over from the amyrlin Mac app's design pass, so the two read as one product:

- **Project colors:** each project has its own color from its name (`app/lib/projects.ts`, the same FNV hash and eleven OKLCH hues as the Mac app, red and amber left out for failed and waiting). Project names in the drawer, the open session's wash and the picker's swatches use it. `test/projects.test.ts` pins two indexes the Mac app's tests also pin.
- **Accent:** violet, `oklch(80% 0.13 300)`, replacing the blue of milestone 2. The sessions column is `#0a0a0a`, a step darker than the transcript.
- **Drawer:** a project's label folds its sessions away, remembered per browser; folded, it shows a count, or that a session needs Brad or is working. The open session is highlighted again: the drawer sets `aria-current="page"` and the CSS had looked for `true`.
- **Project picker:** Recent (projects with sessions, newest first), then each folder largest first, picked from a row of chips; a search ranks name prefixes first and keeps folders. It replaces a ranking that compared names against paths, so recent projects never came first.
- **Desk:** text 15% larger from 60rem; the phone keeps its sizes. The overflow e2e check passes at every width.
- **Icon:** the Flame of Tar Valon, amyrlin's mark (`design/logo/amyrlin-mark.svg` there), violet on the app's background, replaces milestone 3's four-point star in `icon.svg` and the three PNGs. A phone keeps the old icon until the PWA is added to the home screen again.

## The amyrlin Mac app (2026-10-12)

[amyrlin](https://github.com/brad-j/amyrlin), a native Mac app, is a second client of this host: the same sessions show on the phone and the Mac, so one started on either continues on the other. It speaks amyrlin's protocol v1 (its `docs/protocol.md`) over one WebSocket at `/amyrlin`, beside `/api/live`.

- **Code:** `src/amyrlin/translate.ts` turns `watchEvents()` into v1 frames (ported from amyrlin's reference translation); `src/amyrlin/endpoint.ts` handles the commands, the session list and approvals; `src/api.ts` routes the upgrade.
- **Who gets in:** the same `Tailscale-User-Login` check as the API, and no `Origin` header. A native app sends none and a browser always does, so a web page can't open this socket with Brad's identity.
- **Mapping:** a conversation is a session, tied to its project when made (`conversations.create` takes a project directory and the first message); `configure` changes model and thinking only. Pending approvals become `approval.requested`; approved, denied, and expired, stopped or superseded become `approval.resolved` with approve, deny or cancelled. `approval.answer` takes `always`, summaries carry `alwaysAllowed`, and `approval.forget` takes a rule back (2026-10-19). Forks and archiving answer `unsupported`. The app's host ID and handled create request IDs live in a session document, `aludra.amyrlin`.
- **Tests:** `test/amyrlin.test.ts` checks the translation against amyrlin's 18 recorded scenarios and their expected frames (`test/fixtures/amyrlin/`, copied from amyrlin), and drives the endpoint over a socket with a faux model: refusals, a session from the Mac with history paging, approve, deny, stop during an approval, and settings. `scripts/amyrlin-capture.ts` records a session for amyrlin's own reducer test, and `scripts/amyrlin-export-wire.ts` writes amyrlin's `fixtures/wire-v1/` from its recorded scenarios (amyrlin's own Node host, which used to write them, is gone).

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
- **App:** the approved design (`app/`, styles from `design/prototype.html`). Markdown uses gaidin's DOM-building renderer, fonts are self-hosted IBM Plex (`@fontsource`; Fira until 2026-10-13), and the service worker only shows an offline page. Approvals are answerable already, since a waiting session would otherwise look stuck. Ideas, the changes view and the subscription meter wait for milestones 4 and 5.
- **Tests:** `test/api.test.ts` (7) covers the API; `pnpm e2e` (Playwright, 10 checks) runs the app against the faux host at iPhone size and on the desk, and checks 320 to 1280 px for overflow and wrapped buttons. WebKit needs Ubuntu system libraries this machine lacks, so the phone runs are Chromium; the phone itself is the Safari-engine check.
- **The way in:** `https://aludra.<tailnet>.ts.net/`, served by aludra's own Tailscale node: a second `tailscaled` on egwene, run as Brad's user in userspace mode (`deploy/aludra-tailscale.service`, state in `~/.local/share/aludra/tailscale`). It keeps egwene's own Tailscale untouched and needs no root to serve; a Tailscale Service (`svc:aludra`) would have meant tagging egwene. `aludra doctor` checks that node's serve config.
- **Open:** the subscription meter needs the bridge's structured rate-limit data (see milestone 1 findings). Keyboard handling in the installed PWA is unchecked until it's on the phone.

## Milestone 2 design (2026-10-11)

`design/prototype.html` is one self-contained page with sample data; `design/tokens.css` holds its tokens for the app. The first pass (a session index with a starlight bloom) was redone the same day toward Brad's reference screenshots of Mario Zechner's Pi Mobile: the transcript is the screen, chrome is a hairline and a few icons. Every text color meets WCAG AA contrast, and a Playwright pass found no overflow or wrapped buttons at 320, 375, 414, 768 and 1280 px.

- **Look:** near-black, nearly neutral paper (`oklch(16.5% 0.003 260)`); color only in syntax highlighting, state marks and one blue-white accent. IBM Plex Sans at 17px for prose, IBM Plex Mono for commands, paths, calls and code.
- **Session screen:** a header with the menu, the title, the machine and path in mono (dotted underline; tapping it opens the changes), a files icon with the changed-file count, and a menu. User messages are right-aligned blocks; answers are full-width Markdown with a copy button. Each tool call is a mono row (mark, tool, a dotted-underlined argument that opens its output, code or diff, duration); a finished round folds into one line ("read 4 files · ran 2 commands · edited 3"). The running command is a code block with a spinner and a fixed-height tail of its output, so streaming never moves the page. A ↓ button appears when scrolled up.
- **Composer:** flat under a hairline. `+` opens the session menu, the Steer/Queue label toggles how a message is delivered, the model, thinking and context sit beside it, and Stop shows while a run goes (Send appears once there's text). Queued messages wait above it; stopping drops them. An approval docks above it.
- **Sessions:** a drawer from the left (a column on the desk), grouped by machine and directory, most urgent project first, each project name larger and in the accent with a hairline between groups. Rows show a mark (spinner, amber diamond, red crossed circle, check, square), title, latest activity and age; ideas sit under their project with Start. The five-hour and weekly windows are a thin meter at the foot of the drawer. A phone opens on the drawer.
- **New session:** a screen whose path picks the project; the composer starts the session or saves the text as an idea.
- **Failures as themselves:** a safeguard refusal (with the request ID and Copy ID), a test failure and a bridge error each get their own title, detail and next actions.
- **Changes:** totals at the top, files ordered by size with an add/delete bar, each opening to its diff.
- **Phone details:** 16px+ inputs, safe areas, a `visualViewport` fix so the composer and sheets sit above the iOS keyboard, contained scrolling.

Approved by Brad on 2026-10-11, after project names in the drawer were made larger and accent-colored. Brad checked it in Chrome on iOS, which runs on WebKit like Safari, and it looked right. Milestone 3 still checks the keyboard handling in the installed PWA, which runs standalone rather than in a browser tab. Subagents (Pi Mobile's agent count in the header) wait for milestone 6.

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
