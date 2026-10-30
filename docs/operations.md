# Running aludra

## The service

`aludra service install` runs the host as a launchd agent (`io.bradjohnson.aludra`) on macOS or a systemd user unit (`aludra.service`) on Linux. Both start it at login and restart it if it exits. Installing again rewrites the unit and restarts the host; do that after an upgrade, a switch of Node, or a change to the settings.

| | macOS | Linux |
| --- | --- | --- |
| Unit | `~/Library/LaunchAgents/io.bradjohnson.aludra.plist` | `~/.config/systemd/user/aludra.service` |
| Log | `~/Library/Logs/aludra/aludra.log` | `journalctl --user -u aludra` |
| Restart | `launchctl kickstart -k gui/$(id -u)/io.bradjohnson.aludra` | `systemctl --user restart aludra` |
| State | `aludra service status` | `aludra service status` |

The unit carries the PATH of the shell that installed it, plus Node's and Claude Code's directories. Sessions run commands with that PATH. If a session can't find a tool you have in your terminal, install the service again from a shell that finds it. On Linux, the user manager's environment (`systemctl --user show-environment`) often has a fuller PATH than an SSH shell.

Restarting is safe while sessions run. The host resumes them on start: a run killed mid tool call sees the interrupted call, checks where things stand, and carries on.

### The host's log

The host writes to stderr, which the service sends to the log above. Lines worth knowing:

| Prefix | What |
| --- | --- |
| `aludra listening on …` | Started, with the model in use. |
| `aludra API on 127.0.0.1:8724, for …` | The API is up, for these logins. |
| `[models]` | A provider's models that couldn't be listed, or a pinned provider that isn't signed in. |
| `[backup]` | A backup made, or why it failed. |
| `[push]` | A notification that couldn't be sent. |
| `[api]`, `[report]` | Unexpected errors in the API or in Pi Durable's background work. |

## What doctor checks

`aludra doctor` runs every check at once and prints one line each. It never asks a model anything.

| Area | Checks | When it isn't ok |
| --- | --- | --- |
| settings | The file loads and every setting is valid. | Lists each problem. |
| node | Node is 22.18 or later. | Install a newer Node, then `aludra service install`. |
| data | The data directory is writable. | Fix its permissions or `dataDir`. |
| host | Something answers on the CLI socket. | `aludra service install`, or `aludra serve`. |
| workspaces | Each root matches at least one project. | Fix the pattern; `aludra projects` shows the matches. |
| versions | Pi Durable and pi-claude-code are the pinned versions. | See [Upgrading Pi Durable or pi-claude-code](#upgrading-pi-durable-or-pi-claude-code). |
| claude | Nothing in the environment would move Claude Code off the subscription, `claude.path` runs, and Claude Code is logged in to a subscription. Skipped when no choice is a Claude model. | Unset the variable it names; `claude auth login`. A login that isn't a subscription is a warning: runs would be billed. |
| model | The default model's provider has it (for Claude, among the models Claude Code says the account offers). Each choice its provider lacks is a warning, since clients get it left out. | Lists the models the provider has. |
| openrouter | When a choice is an OpenRouter model or the machine is signed in: there's a key. | `aludra login openrouter`. |
| openai | Only when a choice is an OpenAI model: signed in with ChatGPT, and the account offers each one. | `aludra login openai`. An `OPENAI_API_KEY` with no sign-in is a warning: requests would be billed per token. |
| api | `api.users` is set, Tailscale is installed and logged in, and `tailscale serve` points at `api.port`. | Prints the command to run, then the API's and amyrlin's addresses once it's all there. |
| push | Apple's and Google's push services are reachable. | Notifications to those devices won't arrive. |
| video | `ffmpeg` is on the PATH. | Agents see only the frames sent with a video; install ffmpeg. |
| service | Installed, running, and the unit matches this aludra, Node and settings file. On Linux, lingering is on. | Prints the command to run. |
| backup | The newest backup's age, and whether it's on the database's disk. | Warns when it's more than twice `backup.everyHours` old. |

## Backups

While it runs, the host checks a minute after start and every hour after that, and copies the database when the newest copy is older than `backup.everyHours` (default 24). It uses SQLite's online backup, so a copy is consistent even mid-run. Copies are named by their time (`aludra-20261013T091500Z.sqlite`), owner-only, and the newest `backup.keep` (default 7) are kept.

`aludra backup` makes one now, with or without the host running.

By default the copies sit in `backups/` beside the database, which protects against a bad upgrade or a corrupted file but not against losing the disk. Set `backup.dir` to another disk or a synced folder for that. Doctor says which you have.

Losing the database loses session history, ideas, approvals, picked colors and notification sign-ups. It doesn't lose code: sessions work in your project directories.

### Restoring

1. Stop the host: `aludra service uninstall` (or Ctrl+C where `aludra serve` runs).
2. Copy a backup over `aludra.sqlite` in the data directory.
3. Delete `aludra.sqlite-wal` and `aludra.sqlite-shm` beside it.
4. Start the host: `aludra service install`.

Devices signed up for notifications after the backup was made need turning on again.

## Upgrading

Pull and run `sh scripts/install.sh` ([setup.md](setup.md#update)). The lockfile pins every dependency, and the install uses it.

### Upgrading Pi Durable or pi-claude-code

aludra loads pi-claude-code from its source files, and depends on how Pi Durable calls a provider. Both are pinned: Pi Durable and its lockstep packages at 1.3.0, pi-claude-code at a commit on GitHub (it isn't on npm). Doctor fails when either version differs. To move either one:

1. Change the version in a branch. Pi's packages move together: `chord`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-durable`, `pi-mcp`, `pi-telemetry` and `pi-tui` should all be the same exact version. For pi-claude-code, `pnpm add github:earendil-works/pi-claude-code#<commit>` with the full commit hash.
2. `pnpm check`. `test/claude-code.test.ts` tests the wrapper in `src/claude-code.ts`, and `test/claude-code-load.test.ts` loads the real package.
3. Run the live check against the real Claude Code and your own login: `node --no-warnings scripts/live-check.ts`. It runs two sessions at once, a compaction, and a `kill -9` mid tool call with recovery, in a temporary directory, and checks the answers were on the plan's limits. It spends a little of the subscription.
4. Update `PINNED` in `src/doctor.ts` and the versions in [architecture.md](architecture.md) and `docs/plan.md`.

## Troubleshooting

**amyrlin says 403.** Your Tailscale login isn't in `api.users` on that machine, or the request didn't come through `tailscale serve`. Add the login (exactly as `tailscale status` shows it) and restart the host.

**amyrlin says 502.** `tailscale serve` has nothing behind it: the host isn't running, or `tailscale serve` points at another port. `aludra doctor` says which.

**A request gets "Forbidden".** As for 403. If you're on the right login, check you're using the `https://…ts.net/` address and not `127.0.0.1` directly, which has no Tailscale header.

**A browser gets a 404 at the machine's address.** aludra has no web app; only `/api/` and `/amyrlin` answer.

**The host stopped after I logged out (Linux).** `loginctl enable-linger "$USER"`.

**Sessions run on the wrong Claude account.** Set `claude.configDir` to the Claude Code config directory that holds the right login ([configuration.md](configuration.md#claude)), then `aludra service install`. `aludra doctor` shows the directory and account in use.

**A turn fails with "Claude Code subscription provider refuses conflicting auth/backend overrides".** The host's environment sets an Anthropic API key, base URL or another backend, which would bill the runs elsewhere. Unset it where the host starts (the service's environment or your shell), then restart the host. `aludra doctor` names the variable.

**A turn fails with "Claude Code billing".** Claude Code charged it, or would have, to the account's usage credits instead of the plan's limits: the plan's limit is used up, or Anthropic counted the request as third-party app use. aludra stops so nothing more is charged. Wait for the limit to reset, or set `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1` in the host's environment to let such turns run ([configuration.md](configuration.md#environment-variables)).

**Doctor says the service runs a different aludra, Node or settings file.** The unit still names the old paths. `aludra service install`.

**A session says "Refused by the model's safeguards".** The model's classifier refused the request. They're sometimes false positives, triggered by file names or wording that sound like an attack. Send a reworded follow-up. The request ID is there to copy if you want to report it.

**A session says "Rate limited".** The subscription's usage window is spent. It resets on its own; send a follow-up after that.

**A session can't find `pnpm`, `cargo` or similar.** The service's PATH doesn't have it. Install the service again from a shell where `command -v` finds the tool.

**Notifications don't arrive.** A device has to be signed up through `/api/push/subscribe` by a client with a service worker; aludra serves none. `POST /api/push/test` sends a test five seconds later. Check Focus and Do Not Disturb. `aludra doctor` checks the push services are reachable.

**An old session's changes give a git error.** Git keeps the starting snapshot for two weeks at least; after a `git gc` an older session can lose it.
