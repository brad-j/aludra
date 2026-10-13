# aludra

A coding agent host for your own machines. Install it on each macOS or Linux computer whose projects you want to reach,
and use those projects over Tailscale from a web app that runs in any browser, on a phone or a computer. Sessions run
on the machine that has the code, keep going when you close the app, and survive restarts.

The same sessions are also reachable from the command line on the machine, and from
[amyrlin](https://github.com/brad-j/amyrlin), an optional native macOS client that shows several machines at once.

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

Then open `https://<machine>.<tailnet>.ts.net/` in a browser on any device on your tailnet; on a phone, add it to the
home screen. In amyrlin, add the machine as `wss://<machine>.<tailnet>.ts.net/amyrlin`. `aludra init` and
`aludra doctor` print the exact addresses.

To update, pull and run `sh scripts/install.sh` again; it restarts the service. `aludra service uninstall` stops it and
removes the unit; `npm uninstall -g aludra` removes the command.

## Settings

`~/.config/aludra/config.json` (or `$XDG_CONFIG_HOME/aludra/config.json`, or `--config FILE`). Only `workspaces` is
required; `aludra init` writes `workspaces` and `api.users`.

```json
{
	"workspaces": [{ "name": "devbox", "roots": ["~/code/*", "~/work/*/*"] }],
	"api": { "users": ["you@example.com"], "port": 8724 },
	"model": { "id": "claude-opus-5-5", "thinking": "high" },
	"claude": { "path": "claude" },
	"approvals": { "hosts": ["prod-db"], "waitHours": 24 },
	"backup": { "dir": "/mnt/nas/aludra", "everyHours": 24, "keep": 7 }
}
```

[docs/configuration.md](docs/configuration.md) explains each setting, the environment variables and the data directory.

## How it's kept safe

The host listens on 127.0.0.1 only. `tailscale serve` is the way in, and only the Tailscale logins in `api.users` get
through. Inside a project the agent runs without asking; `git push` and remote commands to listed hosts wait for a tap,
and credential files and keys are blocked. Both read shell commands as text, so they guard against mistakes, not a
determined agent. [docs/security.md](docs/security.md) has the details.

## Documentation

- [Setting up a machine](docs/setup.md): requirements, install, the service, Tailscale, connecting the apps, updating.
- [Configuration](docs/configuration.md): every setting, environment variables, the data directory.
- [Using aludra](docs/using.md): sessions, steering, ideas, approvals, changes, notifications, amyrlin.
- [The aludra command](docs/cli.md): every CLI command and its flags.
- [Security](docs/security.md): who gets in, the permissions, what's stored.
- [Running aludra](docs/operations.md): logs, doctor, backups and restoring, upgrades, troubleshooting.
- [Architecture](docs/architecture.md): how the host, the bridge and the apps fit together.
- [API](docs/api.md): the web API, amyrlin's endpoint, the CLI socket.
- [Development](docs/development.md): commands, tests, the faux model, dependencies.
- [Plan](docs/plan.md): decisions, milestones and their reasons.
