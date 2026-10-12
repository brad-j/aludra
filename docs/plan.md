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
- **Permissions: open, with a short exception list.** Inside a project everything runs without asking: edits, builds, tests, installs, commits. Two things wait for one tap from a push: `git push`, and anything reaching homelab hosts (`ssh`, `scp`, `rsync` to think-1, think-2, monitor-01), because egwene's keys reach them. Secrets stay unreadable through a port of `~/.pi/agent/extensions/protected-path-gate.ts` as a Pi Durable `beforeTool` hook (pi extensions don't load in Pi Durable).
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
- **API:** loopback HTTP and WebSocket, exposed through Tailscale Serve, trusting its identity header the way gaidin's web view does (`gaidin/docs/security.md`). Live state from `conversation.watch()`.
- **App:** TanStack Start, built as a PWA (manifest, service worker, Web Push, safe areas). Gaidin's `src/push.ts` and `web/sw.js` are the starting point for push.

## Milestones

1. **Host and CLI.** `aludra ask --project <name> "..."`, `aludra watch`, `aludra doctor`, sessions per project, recovery after `kill -9`. Settle what the spike left open:
   - two conversations running at once through the bridge;
   - compaction (Pi Durable calls the provider for the summary; the bridge's compaction hooks never fire here);
   - the bridge's `process.cwd()`: it uses the host's directory for Claude Code's side of every session (session files, context). Tools already run in each conversation's own directory.
   - the permissions hook and the protected-path port.
   Tests against a faux model; one live check run by hand.
2. **Design pass.** Hallmark, before any app code. A clickable single-file prototype of the home screen, a live session, a session's changes, and idea capture, judged on Brad's phone. Brief in [design-brief.md](design-brief.md).
3. **App.** TanStack Start on the host's API: sessions, transcript, steer, stop, follow-up, new session, model and thinking. Checked with Playwright at phone sizes and on the phone over Tailscale.
4. **Ideas, approvals and push.**
5. **Changes view:** the session's diff since it started.
6. **Subagents:** an `agent` tool on Pi Durable's documented subagent pattern (README, "Abort and Subagents"), children shown under the call. Mario's durable codemode isn't in Pi Durable 1.1.0; script fan-out waits for it.

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
