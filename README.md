# aludra

A coding agent host for your own machines. Install it on each computer whose projects you want to reach, and use those
projects from your phone (the web app) and your Mac (the [amyrlin](https://github.com/brad-j/amyrlin) app) over
Tailscale. Sessions run on the machine that has the code, keep going when you close the app, and survive restarts.

aludra runs Claude Code: the one you install and log in to on that machine. It never asks for or stores Claude
credentials.

## Requirements

- macOS or Linux
- Node 22.18 or later, and pnpm to build (`corepack enable pnpm`)
- [Claude Code](https://claude.com/product/claude-code), logged in: `claude auth login`
- [Tailscale](https://tailscale.com), on this machine and on the devices you'll use it from

## Install

```sh
git clone git@github.com:brad-j/aludra.git && cd aludra
sh scripts/install.sh
aludra init                # asks for your project folders and Tailscale login
aludra doctor              # checks everything, and prints the command for anything that's missing
aludra service install     # runs the host now and at login (launchd on macOS, systemd on Linux)
tailscale serve --bg 8724  # puts it on your tailnet over HTTPS
```

Then add the machine in the Mac app with `wss://<machine>.<tailnet>.ts.net/amyrlin`, or open
`https://<machine>.<tailnet>.ts.net/` on your phone and add it to the home screen. `aludra init` and `aludra doctor`
print the exact addresses.

To update, pull and run `sh scripts/install.sh` again; it restarts the service. `aludra service uninstall` stops it and
removes the unit; `npm uninstall -g aludra` removes the command.

## Settings

`~/.config/aludra/config.json` (or `$XDG_CONFIG_HOME/aludra/config.json`, or `--config FILE`):

```json
{
	"workspaces": [{ "name": "mac", "roots": ["~/code/*", "~/work/*/*"] }],
	"api": { "users": ["you@example.com"], "port": 8724 },
	"model": { "id": "claude-opus-5-5", "thinking": "high" },
	"claude": { "path": "claude" },
	"approvals": { "hosts": ["prod-db"], "waitHours": 24 }
}
```

- `workspaces`: each root is a pattern; every folder it matches is a project.
- `api.users`: the Tailscale logins let in. Everyone listed sees and runs every session on this machine.
- `claude.path`: the Claude Code to run, found on PATH by default.
- `approvals.hosts`: ssh, scp and rsync to these wait for your approval, like `git push` always does.
- `dataDir`: the database and keys. Default `~/Library/Application Support/aludra` on macOS, `~/.local/share/aludra`
  elsewhere.

## How it's kept safe

- The host listens on 127.0.0.1 only. `tailscale serve` is the way in, and it tells aludra who's asking; requests from
  a login not in `api.users`, or without one, are refused. There are no passwords or tokens.
- Inside a project the agent runs without asking: edits, builds, tests, installs, commits. `git push` and remote
  commands to listed hosts wait for a tap. Credential files and keys are blocked. Both read shell commands as text, so
  they're a guard against mistakes, not a sandbox.
- Sessions run as your user, with the PATH the service was installed with.

## Commands

`aludra --help` lists them: `ask`, `watch`, `sessions`, `stop`, `approvals`, `approve`, `deny` and `projects` work
from a terminal against the running host.

## Development

`pnpm check` (types, lint, tests), `pnpm e2e` (Playwright against the built app), `pnpm dev` (the app on Vite, with
the API from a running host). [docs/plan.md](docs/plan.md) has the decisions and their reasons.
