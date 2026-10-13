# aludra

A coding agent Brad reaches from his phone and desk: Pi Durable on egwene, Opus 5.5 through `pi-claude-bridge` on his Claude subscription, a TanStack Start PWA over Tailscale.

- [docs/plan.md](docs/plan.md) holds the decisions, architecture, milestones and spike findings. Read it before starting work, and update it when a decision changes or a milestone is done.
- The rest of `docs/` describes aludra as it is now: setup, configuration, using it, the CLI, security, operations, architecture, the API and development (the README indexes them). Update the matching doc in the same change when a setting, command, endpoint, permission rule or behaviour it describes changes. Keep them general: nothing about Brad's machines, logins or homelab, which belong in plan.md or here.
- [docs/design-brief.md](docs/design-brief.md) is the brief for the Hallmark design pass. Its three answers are settled.
- The landing page and setup guide live in `../aludra-site`. Its setup page follows docs/setup.md, so change both together.
- `spike/` holds the scripts that proved the bridge works in the Pi SDK and in Pi Durable. They're references, not app code.
- Pi Durable and the bridge are pinned. The bridge glue depends on bridge internals, so upgrade either deliberately and rerun the live check.
- Use pnpm. Package versions must be 3 days old before pnpm resolves them (`minimumReleaseAge: 4320`), as in gaidin.
- `src/protected-paths.ts` is a copy of terminal pi's rules in `~/.pi/agent/lib/protected-paths.ts`; keep the two in step by hand.
- Commit messages describe the change in a sentence or two of prose, as the history does.
- gaidin (`../gaidin`) is the sibling project on Pi Durable; borrow from it (push, service worker, Tailscale identity, faux model tests) rather than reinventing.
