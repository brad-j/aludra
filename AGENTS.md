# aludra

A coding agent Brad reaches from his Mac and the terminal: Pi Durable on egwene, Opus 5.5 through `pi-claude-code` (his own Claude Code, `claude -p`) on his Claude subscription, an HTTP API and the `/amyrlin` endpoint loial uses, over Tailscale. It has no web app.

- [docs/decisions.md](docs/decisions.md) holds the decisions, architecture, milestones and spike findings, and [docs/plan.md](docs/plan.md) the open work in the plan format. Read both before starting work; record a decision in decisions.md and move a plan item to Done when it's finished.
- The rest of `docs/` describes aludra as it is now: setup, configuration, using it, the CLI, security, operations, architecture, the API and development (the README indexes them). Update the matching doc in the same change when a setting, command, endpoint, permission rule or behavior it describes changes. Keep them general: nothing about Brad's machines, logins or homelab, which belong in decisions.md, plan.md or here.
- The landing page and setup guide live in `../aludra-site`. Its setup page follows docs/setup.md, so change both together.
- `spike/` holds the scripts that proved pi-claude-bridge, the first Claude provider, in the Pi SDK and in Pi Durable. They're references, not app code.
- Pi Durable and pi-claude-code are pinned, pi-claude-code to a GitHub commit since it isn't on npm. `src/claude-code.ts` loads its source files, so upgrade either deliberately and rerun the live check.
- Use pnpm. Package versions must be 3 days old before pnpm resolves them (`minimumReleaseAge: 4320`).
- `src/protected-paths.ts` is a copy of terminal pi's rules in `~/.pi/agent/lib/protected-paths.ts`; keep the two in step by hand.
- Commit messages describe the change in a sentence or two of prose, as the history does.
- loial (`../loial`) is the client. Its `docs/plan.md` asks for aludra work as `request` items here; its e2e runs against this checkout.
