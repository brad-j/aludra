# Plan

aludra's open work. [decisions.md](decisions.md) holds the decisions and their reasons, and the history of each milestone. The format is the `plan` skill's.

## Now

### retire-amyrlin: Take amyrlin's name out of aludra
Kind: step
amyrlin, the macOS client, is retired (2026-11-20). Brad's calls (decisions.md, "amyrlin retired"): the path is `/app` and the protocol "aludra's app protocol v1"; the `aludra.amyrlin` document kind stays; brad-j/amyrlin is archived; the checkout is removed once nothing reads it.

1. Done: the spec is `docs/protocol.md` and the fixtures are in `test/fixtures/` (`durable-1.1.0`, `wire-v1`, `server-v1`); the scripts write there. The code, tests and docs say `/app`, `src/app/` and `createAppEndpoint`, and `/app` is served with `/amyrlin` as an alias (1d1c7bb).
2. Done 2026-11-21: installed on egwene and the Mac; both answer `host.info` at `/app` and `/amyrlin` over the tailnet with the same host ID.
3. Done 2026-11-21: loial (ddb8939) and pi-desktop (0becd75) use `/app` and rewrite a saved `/amyrlin` address. Both are built on the Mac, but `/Applications/loial.app` and `Pi Desktop.app` were running, so the new builds aren't copied in yet. The Mac's `aludra.json` already says `/app` (the old one is `aludra.json.amyrlin-bak` beside it).
4. Once the Mac's two apps are the new builds: remove the alias from `src/api.ts`, its test in `test/app.test.ts`, and the mentions in `docs/protocol.md`, api.md, operations.md, security.md and `src/app/endpoint.ts`; install on both machines again; sync aludra-site again.
5. Done 2026-11-21: brad-j/amyrlin is archived (still public), and `~/westwood/Projects/Software/amyrlin` is removed (`~/westwood/MIGRATIONS.md`). aludra-site's docs were synced (b448bb2).

## Next

## Questions

## Later

### landed-branch-cleanup: Delete a sandbox branch once its work has landed
Kind: request · From: loial/stale-sandbox-branches
aludra keeps `sandbox/N` after a task is archived: loial's checkout has 62 and aludra's 16 (2026-11-20). Once a sandbox session's work is on its upstream (a landed ship, or its commits reachable from `origin/main`) and it's archived, delete the local branch. Never one with commits not on the upstream. A one-off sweep of the existing ones can use the same check.

### sandbox-template-flake: A sandbox template test fails now and then under the full suite
Kind: chore
"a template made from the previous one checks out the new commit over it…" (`test/sandboxes.test.ts`) failed once in a full `pnpm test` on 2026-11-20 with `ENOTEMPTY` removing `.git/objects` in its temp directory, and passed six times alone, with and without that day's change. Likely a cleanup racing a git process still writing.

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
From the first plan's "Later, maybe". Slack would be a channel per project and a thread per session. loial covers the desktop; voice and a phone companion have no client.

## Done

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
