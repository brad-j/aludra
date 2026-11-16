# Plan

aludra's open work. [decisions.md](decisions.md) holds the decisions and their reasons, and the history of each milestone. The format is the `plan` skill's.

## Now

### plan-convert: Move the plan into this format
Kind: chore
The old plan.md is now decisions.md, unchanged apart from its opening, and its open items are here. Once it's reviewed, decisions.md's "Not yet" and "Later" lines can point here or go.

## Next

### skills-live-check: Run the live check for skills in a sandbox
Kind: chore
`scripts/skills-check.ts SANDBOX_HOST_JSON PROJECT_DIR [SKILL]`: a real sandbox session reads a copied skill file. It hasn't run, since the sandbox it was built in reached neither stedding nor Claude Code ("Skills in sandboxes", decisions.md).

### new-projects-live-check: Try projects.create against GitHub
Kind: chore
Not checked live in November because egwene's gh token was invalid. gh is signed in now and `newProjects` is in egwene's settings, so a real create, and a scratch sandbox promoted with Claude, can run. Delete the test repository by hand afterward.

## Questions

## Later

### subagents: An agent tool with children shown under the call
Kind: step
Deferred 2026-10-12, briefly moved up and put back 2026-11-15: not needed yet. Opus 5.5's 1M window with compaction keeps a session's context, Verin already runs several coding sessions in parallel and shows each, and every child would spend the five-hour window Verin shares. Pi Durable 1.3.0, already pinned, has what it would need (the documented subagent pattern and codemode fan-out), so it's ready to build when it pays off. Reasons to pick it up: sessions often compacting partway through a task because exploring filled the context, or one task regularly split by hand into several Verin sessions whose results are put together by hand. Before building, decide: children on a cheaper model or the parent's, one level deep or more, and how Verin and loial show them.

### usage-meter: Show the subscription's windows
Kind: step
Each answer carries the `claude-code.rate-limit` diagnostic (five-hour and seven-day use, resets, overage). Nothing in aludra reads it yet; Verin shows it.

### setup-only-secrets: Secrets for setup scripts only
Kind: step
After Codex: `.agents/setup` gets a credential, such as a private registry token, and it's removed before the agent's turns start. A smaller step than stedding's placeholder-secrets proxy.

### git-credential-proxy: A credential proxy for a sandbox's git
Kind: step
After Claude Code on the web: the sandbox's git traffic goes through a proxy outside the VM that adds the credential, so a sandbox could push a branch without holding a token. Only matters if sandboxes ever need to push on their own; ship pushes from egwene today.

### idle-pausing: Pause sandboxes on agent idle and human idle
Kind: step
After Amp: pause 5 minutes after the agent stops or 20 minutes after the user last interacted, whichever is later. Today the connection closes after 60 s and matrim's reaper pauses 60 s after that. Measure how often a reply meets a wake, and what a wake costs, before changing it.

### home-routing: Web traffic through a home connection
Kind: step
After Amp's routing: only matters if sandboxes move off matrim to a cloud host, since matrim already uses the home connection.

### worktree-isolation: Isolate worktree sessions on the Mac
Kind: step
A worktree session runs as the owner, outside any sandbox, only unable to push. Seatbelt or a macOS VM is the step after.

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
From the first plan's "Later, maybe". Slack would be a channel per project and a thread per session. Verin now covers voice and the apps, so these may not be needed.

## Done

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
