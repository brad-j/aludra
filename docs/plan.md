# Plan

aludra's open work. [decisions.md](decisions.md) holds the decisions and their reasons, and the history of each milestone. The format is the `plan` skill's.

## Now

### executor-live-check: Sign in to Executor for real and use a tool
Kind: chore · From: pi-desktop/executor-live-check
executor-tools is tested only against pi-host's stand-in. Against executor.sh: `executor.signIn` over `/app` through egwene's tailnet address, the browser coming back to `/api/executor/callback`, Executor's client registration for that redirect, one read-only tool called from a no-project session, a call that needs approval giving its link, and the grant refreshed after a restart. Pi Desktop dropped its own check for this one.

## Next

### subscription-fresh: The subscription's windows as they are now, not as of the last answer
Kind: request · From: pi-desktop/console-layout
`host.info.subscription` is whatever the host's latest answer reported, so use from other clients on the same account (Claude Code in a terminal, claude.ai) doesn't show until aludra answers again. On 2026-11-27 at 17:38 it said 80% of the 5-hour window and 12% of the week, heard at 15:42, while claude.ai's usage page said 38% and 17%: two hours stale, and the 5-hour window had probably reset in between. Pi Desktop now shows the figure's age and dims it past 15 minutes. Read it fresh: ask Claude Code for the windows (a cheap call that returns the rate-limit headers, as its own usage view does) when a client watches and the figure is older than a few minutes, or at least drop a window whose `resetsAt` has passed.

### sandbox-template-flake: Three tests fail or hang now and then
Kind: chore
On 2026-11-27 about half of full runs hit one of them, and the hang stalls `pnpm test` until a timeout, so it's next after the live check. History: "a template made from the previous one checks out the new commit over it…" (`test/sandboxes.test.ts`) failed once in a full `pnpm test` on 2026-11-20 with `ENOTEMPTY` removing `.git/objects` in its temp directory, and passed six times alone, with and without that day's change. Likely a cleanup racing a git process still writing. A second one on 2026-11-21: "sandbox.sync brings the branch home…" (`test/app.test.ts`) failed once in a full run with `Unable to create '/tmp/aludra-sync-*.bundle.lock': File exists`, and passed alone five times and in the next full run. On 2026-11-24 the first one failed in 2 of 4 runs of `test/sandboxes.test.ts` alone, again `ENOTEMPTY` on the project's `.git`, and passed in the full run. On 2026-11-27 it failed in 2 of 3 runs alone and in 3 of 6 full runs. A third: "a worktree task runs on this machine in a worktree of its own…" (`test/app.test.ts`) hung until a 90 s timeout in 1 of 3 runs alone with that day's changes stashed, and in one full run; a hung run leaves the whole suite waiting, which looks like `pnpm test` never finishing.

## Questions

## Later

### apns-push: Pushes to Pi Desktop's iOS app through APNs
Kind: request · From: pi-desktop/ios
The iOS app's WebView can't take Web Push, so the host sends APNs: device registration over `/app`, a token-based APNs key in the settings file, and a push when a session asks, fails or finishes, or a ship lands or stops, with the conversation to open. Replaces Web Push (drop-web-push).

### drop-web-push: Take out Web Push
Kind: chore · Needs: pi-desktop/desktop-notifications
Once Pi Desktop sends coding notifications from `host.watch` (an iOS app would need apns-push first; Verin stopped on 2026-11-27), `/api/push/*`, the VAPID key (`push-keys.json`) and the push sender have no user. Check nothing is subscribed first: devices are in the `aludra.push` document in the database.

### plan-first-setting: Refuse tasks with no plan item, per project
Kind: step
A project setting that makes `start_session` and `conversations.create` refuse a task without `planItem`, so no client can start untracked work there. Only if untracked tasks keep turning up; for now Pi Desktop holds the rule itself, starting tasks from its plan view.

### setup-only-secrets: Secrets for setup scripts only
Kind: step
After Codex: `.agents/setup` gets a credential, such as a private registry token, and it's removed before the agent's turns start. A smaller step than stedding's placeholder-secrets proxy.

### git-credential-proxy: A credential proxy for a sandbox's git
Kind: step
After Claude Code on the web: the sandbox's git traffic goes through a proxy outside the VM that adds the credential, so a sandbox could push a branch without holding a token. Only matters if sandboxes ever need to push on their own; ship pushes from egwene today.

### home-routing: Web traffic through a home connection
Kind: step
After Amp's routing: only matters if sandboxes move off matrim to a cloud host, since matrim already uses the home connection.

### worktree-isolation: Isolate worktree sessions on the Mac
Kind: step
A worktree session runs as the owner, outside any sandbox, only unable to push. Seatbelt or a macOS VM is the step after.

### ship-branch-live-check: Try shipping in branch mode against GitHub
Kind: chore
`sandboxes.shipTo: "branch"` pushes `sandbox-N-<sha>` and opens a pull request with `gh pr create`. Only the tests have run it; the live ship checks used `main` mode, since there was no throwaway GitHub repository. gh can now make private repositories (new-projects-live-check), so a scratch one would do.

### page-self-check: A headless-browser check of published pages
Kind: step
`publish_page` has no check that a page renders. Add one if pages come out broken.

### pi-env-upgrade: pi-env 1.5.0
Kind: chore
pi-env is pinned at 1.3.0 with the rest of Pi's lockstep packages; 1.5.0 waits for the lockstep upgrade.

### monitoring-hook: Hook aludra into the homelab's alerts
Kind: chore
The failed-unit ntfy alerts or a monitor-01 health check, once a silent failure is missed.

### offsite-backup: Keep backups off egwene's disk
Kind: chore
Backups sit beside the database. `backup.dir` on another disk or a synced folder would keep copies off it; losing the database loses session history, not code.

### api-key-provider: API keys as a second provider
Kind: step
For a machine without a Claude subscription, through pi-ai. Not needed while every machine is Brad's.

### public-mark: An original mark before any public release
Kind: chore
The Flame of Tar Valon is a Wheel of Time symbol. Both repositories are private, so it stays until a release is planned.

### more-surfaces: Slack, voice, a native companion
Kind: step
From the first plan's "Later, maybe". Slack would be a channel per project and a thread per session. Pi Desktop covers the desktop and is the start of a phone client (pi-desktop/ios, with apns-push); voice has none.

## Done

### landed-branch-cleanup: Delete a sandbox branch once its work has landed
Kind: request · From: loial/stale-sandbox-branches · Done: 2026-11-27
Once an archived sandbox session's sandbox is gone, `deleteLandedBranch` (`src/sandbox-cleanup.ts`) deletes its `sandbox/N` when the head is on the ship base's remote-tracking ref; a commit the upstream lacks, or a checked-out branch, keeps it. A sweep at start covers sessions archived before. Nothing is fetched for the check.

### executor-tools: Executor's tools in sessions
Kind: step · From: pi-desktop/aludra-host · Done: 2026-11-27
`src/executor.ts`, from pi-host: browser approval mode, the grant in `executor-auth.json` at 0600, refresh on a 401, the tools as `executor_*` with the `executor` section, and `call`, `execute` and `resume` not replayed. Only local no-project sessions get them. `/app` has `executor.status`, `executor.signIn` and `executor.signOut`, `host.info.executor` and the `executor.changed` event; the redirect comes back to `/api/executor/callback` at the host's tailnet address. Tested against the stand-in only; the real sign-in is executor-live-check. decisions.md, "Executor on the host".

### setup-notes: Notes on the user's setup, read on demand
Kind: step · From: pi-desktop/aludra-host · Done: 2026-11-27
`src/setup-notes.ts`: `setup/` in the data directory, or `setup.dir`, holds `README.md` (the map, in the prompt) and `<topic>.md` notes for `read_setup`, for local no-project sessions only. No notes are in the repository; egwene's were written the same day, from pi-host's, in its data directory. decisions.md, "Setup notes as files".

### drop-verin-mcp: Take out the MCP write side Verin used
Kind: chore · Needs: verin/drop-coding · Done: 2026-11-27
Removed again: the `check_sessions` gate, `write_plan`, `ship_session`, `create_project` and `promote_session` with their settings and stores, and scratch `start_session`. `/app`'s `projects.writePlan`, `projects.create` and ship stay. decisions.md, "MCP write side trimmed again (2026-11-27)". verin/drop-coding-vm was deployed the same day; every MCP token on egwene is revoked, and Brad took `mcp.ship` and `mcp.writePlans` out of its settings.

### chat-auto-archive: Should idle archiving skip no-project sessions?
Kind: question · From: pi-desktop/aludra-host · Done: 2026-11-27
Brad: skip them; idle archiving applies only to project sessions. Built as a step: `archiveIdle` (`src/archive.ts`) leaves sessions with no project alone, the setting's help and the docs say so, and the archive test checks a scratch session and a no-project chat stay. decisions.md, "Idle archiving is for project sessions".

### app-compaction-failure: Say when a compaction failed
Kind: step · From: pi-desktop/aludra-host · Done: 2026-11-27
The `conversation.watch` snapshot carries `compactionFailure: {taskId, reason, error}` from `pi.live.compactionFailure`, left out when there's none so the recorded wire fixtures still match, and `compaction.ended` carries `error` from Durable's `compaction_end`, which is the event when it changes. protocol.md section 10 item 23 and api.md say so. An app test fails a manual compaction with an empty summary, sees both, then clears it with one that works.

### app-withdraw: Withdraw one queued message over /app
Kind: step · From: pi-desktop/aludra-host · Done: 2026-11-27
`submission.withdraw {conversationId, submissionId}` on `/app` calls `host.withdraw`, as HTTP's withdraw does, and answers `{result}`. protocol.md has it as section 10 item 22 in place of the Deferred line; api.md says so. An app test queues a follow-up behind a slow command, withdraws it, and checks `settled`, `not_found` and bad requests.

### web-tools: web_search and fetch_url for sessions
Kind: step · From: pi-desktop/aludra-host · Done: 2026-11-27
pi-host's `web` extension is `src/web-tools.ts`, with `web-fetch.ts`, `web-reviewer.ts` and `web-keys.ts`, installed for every session. Keys are `tavily.key` and `jev.key` in the data directory, and `host.info` carries `web.keys` and lists both tools. The reviewer stays and bash isn't gated: decisions.md, "Web tools (2026-11-27)". Its tests came over against local stubs, with one through a faux session. The real Tavily and Jev weren't called.

### app-model-input: Say which models take images in host.info
Kind: request · From: pi-desktop/aludra-host · Done: 2026-11-27
Each `host.info` model carries `input` and `maxTokens` from its catalog entry (`host.modelInfo`), as protocol.md section 5 gives them, left out for a model no provider has loaded. api.md says so; the app test checks a faux model's.

### ideas: Ideas on the host
Kind: request · From: pi-desktop/ideas-home · Done: 2026-11-27
Pi Desktop's ideas clone and tools are in aludra: `src/ideas-repo.ts` (the clone, local-first sync, undo) and `src/ideas.ts` (the operations, the six tools and the `idea-chat` section), behind a file-only `ideas.dir`. Only local no-project sessions get the tools. `/app` has `ideas.list`, `read`, `file`, `capture`, `setStatus`, `setAreas`, `delete`, `undo`, `reverted`, `sync`, `draft`, `makeProject` and `brainstorm`, `host.info.ideas`, the `ideas.changed` event and `idea` on summaries. Idea files list sessions in `sessions:` as `<machine>/<id>`. egwene's settings set `ideas.dir` the same day. decisions.md, "Ideas on the host (2026-11-27)".

### drop-old-ideas: Take out aludra's saved first messages
Kind: chore · Done: 2026-11-27
Brad's call, so ideas can mean the ideas repository: `aludra.ideas`, `host.ideas`, `/api/ideas` and its three routes, and the `ideas` event on `/api/live` are gone. No client called them, and egwene's database held no `aludra.ideas` document. decisions.md, "What Pi Desktop's chats need".

### desktop-tools: What Pi Desktop's chats need from the host
Kind: request · From: pi-desktop/aludra-host · Done: 2026-11-27
Compared pi-host (`packages/pi-host` at 972da65) with aludra's no-project sessions. Gaps, each an item: web-tools, executor-tools, setup-notes, app-withdraw, app-compaction-failure, and the question chat-auto-archive. Already here: titles (written by a model), rename, retitle, archive, message search with an index, history paging, compact, models and thinking, images, pages and subagents; skills and files go beyond pi-host. The ideas tools and a chat's idea link are the ideas item. decisions.md, "What Pi Desktop's chats need (2026-11-27)".

### plan-writes-commit: Should a plan write commit docs/plan.md?
Kind: question · Done: 2026-11-25
Brad: commit just `docs/plan.md` after each write when nothing else is staged. Built in `commitPlan` (`src/plans.ts`) for `write_plan` and `projects.writePlan`; the answer carries `commit` or `uncommitted` with the reason. decisions.md, "Plan writes commit (2026-11-25)".

### mcp-start-plan-item: start_session takes the plan item a session is for
Kind: request · From: verin/start-from-plan-item · Done: 2026-11-24
MCP `start_session` takes `planItem`, a plan item's id in the project's `docs/plan.md`, checked and kept on the session as `conversations.create`'s is since plan-items, so a task Verin starts shows against its item in loial's plan view. It also takes `origin`, an optional https URL (a Verin thread), kept on the session and carried in its summary on `/app` and in `list_sessions` and `check_sessions`, so loial can link back. Per decisions.md, "Tasks start from the plan (2026-11-24)". Built: `start_session` checks the item is in the plan as `read_plan` reads it; `planItem` and `origin` show in `list_sessions`, `read_session`, `check_sessions` and the `/app` summary.

### app-write-plan: Plan writes over /app
Kind: request · From: loial/add-to-plan · Done: 2026-11-24
`projects.writePlan {project, text, base}` on `/app`, the same `writePlan` as MCP's `write_plan` (format check, ids kept, `sha256` base, refused while a checkout session runs), with `projects.plan` answering the `sha256`. Replaces the dropped write-plan-amyrlin: loial now adds items, since a chat is how work gets into the plan. Built with `projects.plan` now carrying `text` and `sha256`; a stale base is a new error code, `conflict`, a busy checkout `busy`, and a format problem `bad_request` with `data.problems`. No setting gates it, since `/app` is the owner's login.

### create-project-plan: A starting plan on MCP create_project
Kind: request · From: verin/ideas-make-project · Done: 2026-11-24
`create_project` takes `plan: { steps?, questions? }`, checked with `checkSeed` when it's asked for and kept with the request (a `plan` column in `project-requests.sqlite`, added to older files when opened), then written by `writeStarters` once the owner approves, as `projects.create` does. Asking again may leave `plan` out; a different one while the request waits is an error. `aludra approvals` shows how many steps and questions it carries. See decisions.md, "create_project takes a plan (2026-11-24)".

### unretire-verin: Put back the MCP write side for Verin
Kind: step · Done: 2026-11-22
Brad brought Verin back on 2026-11-22, so c8e3cbd is reverted: the check_sessions gate, write_plan (`mcp.writePlans`), ship_session (`mcp.ship`, `mcp.shipWorktrees`), create_project and promote_session (`mcp.allowNewProjects`) and scratch start_session are back, under `/app` naming. retire-agent-mcp's removal no longer holds. See decisions.md, "Verin back (2026-11-22)".

### retire-amyrlin: Take amyrlin's name out of aludra
Kind: step · Done: 2026-11-21
The app protocol is at `/app`, "aludra's app protocol v1" (1d1c7bb): `src/app/`, `createAppEndpoint`, `test/app.test.ts`, `scripts/app-capture.ts` and `app-export-wire.ts`. The spec is `docs/protocol.md` and the fixtures `test/fixtures/` (`durable-1.1.0`, `wire-v1`, `server-v1`), so nothing reads `../amyrlin`. The `aludra.amyrlin` document kind stays, as stored data. loial (ddb8939) and pi-desktop (0becd75) moved to `/app` and rewrite a saved `/amyrlin` address; their new builds are in the Mac's /Applications. The `/amyrlin` alias was then removed, and a test checks it no longer answers. brad-j/amyrlin is archived and the checkout removed (`~/westwood/MIGRATIONS.md`). aludra-site's docs are synced. decisions.md, "amyrlin retired", has Brad's calls.

### starter-files: A new project's starter files and plan
Kind: request · From: pi-desktop/ideas-make-project · Done: 2026-11-20
`projects.create` (so loial's New project too) commits `AGENTS.md`, a `CLAUDE.md` of `@AGENTS.md`, and `docs/plan.md` in the plan format beside the README (`src/starters.ts`). `plan: { steps?, questions? }` seeds it: the first step in Now, the rest in Next, questions under Questions, ids from titles. `ui: true` copies `DESIGN.md` and `PRODUCT.md` from the new `newProjects.designSeeds`, and `host.info`'s `newProjects.ui` says whether it can. `sandbox.promote` adds none. The text lives in aludra so any machine makes the same project with no other checkout (Brad's call, 2026-11-20); a test checks the plan against the format and, where the plan skill is installed, that the skill still names the same sections and kinds. egwene's settings point `designSeeds` at tar-valon's `design/`.

### retire-agent-mcp: Which MCP pieces go now that Lan and Verin are retired?
Kind: question · Done: 2026-11-20
Removed: the check_sessions gate, write_plan (`mcp.writePlans`), ship_session (`mcp.ship`, `mcp.shipWorktrees`), create_project and promote_session (`mcp.allowNewProjects`), and scratch start_session. Kept: the read tools, start/send/stop/archive/unarchive under `mcp.write`, `mcp.sandboxOnly`, `mcp.worktreeOnly` and tokens. See decisions.md, "MCP write side trimmed". Lan's and Verin's tokens still need revoking (`aludra token`).

### write-plan-amyrlin: write_plan over /amyrlin for Verin and loial
Kind: step · Needs: write-plan · Done: 2026-11-20
Dropped 2026-11-20: it was for Verin's Plans, and Verin is retired; loial doesn't edit plans.

### write-plan-commit: Optionally commit docs/plan.md after a write
Kind: step · Needs: write-plan · Done: 2026-11-20
Dropped 2026-11-20: write_plan's only caller was Verin, which is retired.

### worktree-ship-live-check: Ship a worktree session on the Mac
Kind: chore · Done: 2026-11-20
Dropped 2026-11-20: the MCP worktree ship (`mcp.shipWorktrees`) was Verin's, and Verin is retired. loial ships worktree tasks over `/amyrlin` with `sandbox.ship`.

### subagents-clients: Show subagents under their call in Verin and loial
Kind: step · Done: 2026-11-20
Moved 2026-11-20 to loial/subagents: aludra's side is done, and with Verin retired loial is the only client to draw them.

### usage-meter-clients: Show the subscription's windows in Verin and loial
Kind: step · Done: 2026-11-20
Moved 2026-11-20 to loial/usage-meter: aludra's side is done, and with Verin retired loial is the only client to draw them.

### approval-risk: Mark approvals that push or destroy work
Kind: request · From: loial/approval-risk · Done: 2026-11-20
`riskFor` in `src/permissions.ts` reads the command with the approval rules' word splitting: `destructive` for `rm` with `-r` or `-f`, `git reset --hard`, `git clean -f`, `git checkout --` or `.`, `git restore` of the working tree, `git branch -D`, and a force, `+ref`, `:ref`, `--delete` or `--mirror` push; `push` for any other `git push`; destructive wins. `wireApproval` adds it to `approval.requested` and summaries' approvals on `/amyrlin`. Redirects that overwrite tracked files weren't added: telling them apart from writing a new file needs the checkout, and the approval rules don't parse redirects. A unit test covers each form and its near misses, and the amyrlin test checks faux's `git push` approval carries `risk: "push"`. `tsc`, lint and `pnpm test` pass (319 of 320; the one failure is sandbox-template-flake, which passes alone and on main).

### write-plan-busy-session: Should write_plan refuse while a session runs in the project?
Kind: question · Done: 2026-11-19
Yes: it refuses while a session in the project's checkout is running or waiting, naming it; sandbox, worktree and chat sessions don't count. decisions.md, "write_plan over MCP".

### write-plan: write_plan over MCP
Kind: step · Done: 2026-11-19
Behind the file-only `mcp.writePlans` with `mcp.write`, a write token replaces a project's `docs/plan.md` in its checkout from `read_plan`'s new `sha256`, refused when the file changed since. `checkPlan` in `src/plans.ts` enforces the format and keeps every id; the write is atomic, serialized per project and never follows a link. It writes the checkout under `mcp.sandboxOnly` and `mcp.worktreeOnly` too, and stages nothing. Over `/amyrlin` is write-plan-amyrlin; committing is write-plan-commit.

### idle-pausing: Pause sandboxes on agent idle and human idle
Kind: step · Done: 2026-11-19
A sandbox's connection closes at the later of 4 minutes after the agent's last call and 19 after the user last sent a message, answered an approval or opened the session, so with matrim's reaper it pauses at 5 and 20, after Amp. Each wake is logged with how long it slept and what it cost, for tuning. Not checked live on matrim.

### usage-meter: Show the subscription's windows
Kind: step · Done: 2026-11-19
The host reads each answer's `claude-code.rate-limit` diagnostic (`src/subscription.ts`), children's included, and keeps the latest of each window, saved across restarts. `host.info`, `host.snapshot` and a `host.subscription` event carry it over `/amyrlin`, MCP's `read_subscription` answers it, and `aludra sessions` shows it at its foot. Drawing it in Verin and loial is usage-meter-clients.

### subagents: An agent tool with children shown under the call
Kind: step · Done: 2026-11-19
Sessions get an `agent` tool (`src/subagents.ts`): a child conversation owned by the call, on `subagents.model` (default Sonnet 5.5, falling back to the session's model), one level deep, running where its session runs with its session's approvals. The call's details carry the child's ID; `/amyrlin`'s `conversation.watch` and `conversation.history` open a child with `parent` set, and children stay out of the lists. Drawing children under the call in Verin and loial is subagents-clients.

### loial-followups: Titles, chat refusals, worktree checks and chats on macOS
Kind: request · From: loial · Done: 2026-11-19
Found testing loial on raken. A title's leading label ("Session title:", in bold or not) is stripped. A chat's write or edit outside its directory is blocked by a hook with the reason, where the tool alone said only "permission_denied". A worktree task's declared checks run in its worktree after each answer, as a sandbox's do, with code counts from the commit it started at; no screenshots, since a dev server here would share the machine's ports. A chat's commands run under Seatbelt on macOS (`CHAT_SEATBELT` in `src/chat-env.ts`), checked on the Mac, where they had run none for want of bubblewrap.

### loial-links: A task started from a chat, and a chat about a task
Kind: request · From: loial · Done: 2026-11-19
`conversations.create` takes `from` and `about`: the session is linked to the other, told of it in a `linked` prompt section (an excerpt, and where a task's work is), and its summary carries the link. For loial's "Start a task from this" and "Ask about this" (its plan, "Tasks and chats", step 5).

### loial-tasks-chats: Worktree tasks and read-only chats over /amyrlin
Kind: request · From: loial · Done: 2026-11-18
`conversations.create` takes `worktree` and `chat`, summaries carry `worktree` and `chat`, and `sandbox.ship` ships a worktree task. A chat reads anything and writes only `chats/<id>` in the data directory: its file tools check paths (`src/chat-env.ts`) and its commands run under bubblewrap with the file system read-only. Brad chose read-only chats and worktree tasks in place of sessions in the checkout for loial (its plan, "Tasks and chats", step 4). [api.md](api.md#amyrlins-endpoint-ws-amyrlin) has both.

### plan-items: A project's plan items over /amyrlin, and the item a session was started for
Kind: request · From: loial · Done: 2026-11-18
`projects.plan { project }` answers the items of the project's `docs/plan.md` (`planItems` in `src/plans.ts`), and `conversations.create` takes `planItem`, kept on the session and carried in its summary. For loial's list of what to start (its plan, "Tasks and chats", step 3). [api.md](api.md#amyrlins-endpoint-ws-amyrlin) has both.

### worktree-ship: ship_session for a worktree session
Kind: request · From: verin/worktree-ship · Done: 2026-11-17
`mcp.shipWorktrees` (file-only, off by default) lets ship_session ship a worktree session on this machine: rebased in its worktree onto `refs/worktree/aludra/base`, the declared checks run there with a sandbox ship's rule for base failures, pushed from the project's checkout. check_sessions reports it as it does a sandbox ship's. The live check on the Mac is worktree-ship-live-check.

### plan-convert: Move the plan into this format
Kind: chore · Done: 2026-11-16
decisions.md's "Not yet" and "Later" lines now name their plan items, or say what settled them. The untested `branch` ship mode became ship-branch-live-check.

### ship-over-mcp: ship_session for Verin
Kind: step · Done: 2026-11-16
A write token with mcp.ship ships a sandbox session as the apps' Ship does; list_sessions, read_session and check_sessions say how it went, and check_sessions wakes on a ship landing or stopping. Verin's Ship button calls it.

### claude-code-skills: Claude Code's skills in sessions, host.info and sandboxes
Kind: step · Done: 2026-11-19
`~/.claude/skills` (under the Claude Code config directory in use) comes after `~/.pi/agent/skills`, losing name clashes to it. Sandboxes get a copy in `~/.claude/skills`.

### new-projects-live-check: Try projects.create against GitHub
Kind: chore · Done: 2026-11-15
`scripts/new-projects-check.ts` passed: a private repository with its first commit, and a scratch sandbox promoted to a second. Delete brad-j/aludra-check-a and -b by hand.

### skills-live-check: Run the live check for skills in a sandbox
Kind: chore · Done: 2026-11-15
Passed on matrim with Claude, after fixing what it found: a dangling link in the skills directory stopped every copy, so sandboxes had no skills.

### strip-invisible: Strip zero-width and tag characters from incoming text
Kind: step · Done: 2026-11-15
Every message, in host.submit, with a note to the agent saying how many. Files, pages and tool output aren't cleaned.

### relay-terms: Is the loopback relay in front of Claude Code acceptable?
Kind: question · Done: 2026-11-15
Accepted as is ("pi-claude-code", decisions.md).

### read-plan: read_plan over MCP
Kind: step · Done: 2026-11-15 94a0cf0
A project's docs/plan.md from its working copy, for Verin's Plans.

### worktree-sessions: Sessions in a git worktree, and mcp.worktreeOnly
Kind: step · Done: 2026-11-15 fe8b158
For the Mac, which has no sandbox host. Archiving removes the worktree and keeps the branch (55d4a2c).

### mcp-new-projects: create_project and promote_session over MCP
Kind: step · Done: 2026-11-09
Behind the file-only `mcp.allowNewProjects`: a call stores a request in `project-requests.sqlite` and answers pending, and nothing is made until the owner approves it with `aludra approve` or `POST /api/approvals/:id`. Under `mcp.worktreeOnly` only `create_project` is offered. decisions.md has the reasons ("Lan as captain over MCP").

### mcp-scratch-sessions: start_session without a project
Kind: step · Done: 2026-11-09
A write token's `start_session` with no project makes a scratch sandbox session from the empty scratch repository, sandboxOnly or not; with no sandbox host, under `mcp.worktreeOnly`, or with `worktree: true`, it's refused and nothing is made. decisions.md has the reasons ("Lan as captain over MCP").

### mcp-gate: check_sessions and mark_sessions_handled
Kind: step · Done: 2026-11-07 50fe115
A gate for an agent that wakes on session changes, with a cursor per token. Lan's connector and Verin use it. Model and effort per turn (48c6a36), archive and unarchive (1c47932).

### mcp-tokens: A bearer token per agent on /mcp
Kind: step · Done: 2026-11-06 f9756d1
Read-only unless made with --write; mcp.sandboxOnly from 2026-11-07 (d420b68).

### sandbox-skills: Skills in sandboxes and host.info
Kind: step · Done: 2026-11-07 3a2587b
The live check is skills-live-check.

### loial-milestone-a: loial's four changes
Kind: step · Done: 2026-11-05 252e9cc
task.code and result blocks for local sessions, instructions without a result page, and the fake sandbox host.

### ship-checks: The host runs a ship's checks
Kind: step · Done: 2026-11-06 0aecc21

### sandbox-tasks: Sandbox tasks, steps 1 to 6
Kind: step · Done: 2026-11-04 94b2845
amyrlin's item 19: the basics, approvals off, checkout state, results, screenshots, groups, pushes and ships.

### new-projects: New projects, scratch sandboxes, resume and sizes
Kind: step · Done: 2026-11-04 fb29d8f
amyrlin's item 20. The live check is new-projects-live-check.

### sandboxes: Sessions in stedding sandboxes
Kind: step · Done: 2026-11-03 87af194
A sandbox per session from a project template, commits home as sandbox/N, ship from egwene.

### t3-items: The T3 Code items
Kind: step · Done: 2026-11-01 50d3a8c
Retitle, checkpoints, search, attachments, MCP, auto-archive, then visual replies.

### pi-claude-code: pi-claude-code in place of pi-claude-bridge
Kind: step · Done: 2026-10-30 a47ec00

### no-web-app: No web app or terminal UI
Kind: step · Done: 2026-10-24 ce4eb5d

### release-host: aludra on any machine
Kind: step · Done: 2026-10-13
Settings and data per platform, the package, `aludra init`, the service and the install script. Private, installed from a checkout.

### first-milestones: Host, CLI, design, app, ideas, approvals, push, changes
Kind: step · Done: 2026-10-11
Milestones 1 to 5. The app went with the web app on 2026-10-24.
