# Setting up a machine

Install aludra on each macOS or Linux computer whose projects you want to reach. Each one runs its own host, with its own sessions, at its own address on your tailnet. The web app talks to one machine at a time, at that machine's address. amyrlin, the optional macOS client, can show several machines at once.

## Requirements

- macOS or Linux. The service commands use launchd on macOS and systemd on Linux; elsewhere `aludra serve` runs in the foreground.
- Node 22.18 or later.
- pnpm, to build. `corepack enable pnpm` is enough; the repository pins the version it wants.
- npm, which comes with Node. The install script uses it to install the packed build globally.
- git, for the changes view. Projects outside git still work; they just have no changes view.
- [Claude Code](https://claude.com/product/claude-code), installed and logged in with `claude auth login`. aludra runs this binary and never sees your credentials. A subscription login is what you want: `aludra doctor` warns when Claude Code is logged in some other way, since runs would then be billed.
- [Tailscale](https://tailscale.com), on this machine and on every device you'll use aludra from.

## Install

```sh
git clone git@github.com:brad-j/aludra.git && cd aludra
sh scripts/install.sh
```

`scripts/install.sh` checks Node, npm and pnpm, runs `pnpm install --frozen-lockfile`, packs the package (which builds the host into `dist/host` and the app into `dist/client`), and installs the tarball with `npm install --global`. It then says what to do next. If a service is already installed, it reinstalls it so the new version runs.

The checkout stays where it is. The host runs the installed package, so you can keep developing in the checkout without touching the running host.

## Write the settings

```sh
aludra init
```

`aludra init` writes `~/.config/aludra/config.json` (or `$XDG_CONFIG_HOME/aludra/config.json`). It asks three things, each with a guess you can accept with Enter:

- **Project folders.** Patterns whose matches are projects, such as `~/code/*`. The guess comes from where git repositories are under your home directory: each repository's parent with `/*`, and sibling parents folded into one pattern (`~/Projects/Software` and `~/Projects/Tools` become `~/Projects/*/*`). A pattern is suggested only when it matches at least two repositories and at least half its matches are repositories.
- **Tailscale logins.** Who may use this machine through the apps. The guess is the login this machine's Tailscale is signed in as.
- **This machine's name.** The workspace name the apps show. The guess is the host name.

To run it without questions, pass the answers and `--yes`:

```sh
aludra init --root '~/code/*' --root '~/work/*/*' --user you@example.com --name devbox --yes
```

`aludra init` refuses to overwrite an existing settings file unless you pass `--force`. Everything else in the file has a default; [configuration.md](configuration.md) lists every setting.

## Check it

```sh
aludra doctor
```

Doctor checks the settings, Node, the data directory, each workspace pattern, the pinned versions, Claude Code's login, the model, the built app, Tailscale and `tailscale serve`, the push services, the service, and backups. Each line is `ok`, `warn`, `fail` or `skip`, and anything that isn't `ok` says what to run. It exits 1 if anything failed. It doesn't start a Claude Code query, so it costs nothing to run. [operations.md](operations.md#what-doctor-checks) explains each check.

## Run it as a service

```sh
aludra service install
```

This writes a launchd agent (`~/Library/LaunchAgents/io.bradjohnson.aludra.plist`) on macOS or a systemd user unit (`~/.config/systemd/user/aludra.service`) on Linux, and starts it. The unit runs this Node and this aludra, with the PATH of the shell you ran it from, plus Node's and Claude Code's directories. Sessions run their commands with that PATH, so install from a shell that finds git, pnpm and the rest of your toolchain.

It refuses while an `aludra serve` runs outside the service; stop that one first.

On Linux, a user unit stops when you log out unless lingering is on. If the machine should serve while nobody is logged in:

```sh
loginctl enable-linger "$USER"
```

## Put it on your tailnet

```sh
tailscale serve --bg 8724
```

The host listens on `127.0.0.1:8724` only. `tailscale serve` gives it an HTTPS address on your tailnet, `https://<machine>.<tailnet>.ts.net/`, and tells aludra which Tailscale login is asking. The setting persists in Tailscale's state, so you run this once. `aludra init` and `aludra doctor` print the exact command and addresses for this machine.

## Connect the apps

**The web app.** Open `https://<machine>.<tailnet>.ts.net/` in a browser on any device on your tailnet. It's a PWA: on a phone, add it to the home screen to run it as an app (on iOS, Safari's Share, then Add to Home Screen). On iOS, notifications only work in the home screen app. Turn notifications on from the foot of the sessions drawer on each device; see [using.md](using.md#notifications). From 60rem wide the app uses a wider layout with the sessions in a column.

**amyrlin (macOS, optional).** In [amyrlin](https://github.com/brad-j/amyrlin), add the machine as `wss://<machine>.<tailnet>.ts.net/amyrlin`, or just its tailnet name. A machine that can't connect says why under its name in the sidebar: 403 means your login isn't in `api.users`, 502 means nothing is behind `tailscale serve`.

**The CLI.** On the machine itself, `aludra` talks to the running host directly; see [cli.md](cli.md).

## Update

```sh
cd aludra && git pull && sh scripts/install.sh
```

The script reinstalls the service, which restarts the host on the new version. Sessions that were running pick up where they left off. A new build of the app needs that restart too, since the host reads `dist/client` at start.

## Uninstall

```sh
aludra service uninstall   # stops the host and removes the unit
npm uninstall -g aludra    # removes the command
```

Your settings (`~/.config/aludra/`) and data (see [configuration.md](configuration.md#the-data-directory)) stay until you delete them. Run `tailscale serve reset` if nothing else on the machine uses `tailscale serve`.

## Optional: a Tailscale node of aludra's own (Linux)

By default the app is at the machine's own tailnet name. On Linux you can give it a name of its own, such as `https://aludra.<tailnet>.ts.net/`, without touching the machine's Tailscale: run a second `tailscaled` as your user, in userspace mode, with its state in aludra's data directory. Serving through it needs no root. aludra finds its socket at `tailscale/tailscaled.sock` in the data directory and uses it for `init` and `doctor`.

```sh
ln -s "$PWD/deploy/aludra-tailscale.service" ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now aludra-tailscale
tailscale --socket ~/.local/share/aludra/tailscale/tailscaled.sock up --hostname aludra   # prints a login link, once
tailscale --socket ~/.local/share/aludra/tailscale/tailscaled.sock serve --bg 8724
```

The unit in `deploy/` assumes the default Linux data directory, `~/.local/share/aludra`.
