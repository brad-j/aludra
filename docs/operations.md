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
| `aludra app and API on 127.0.0.1:8724, for …` | The app is up, for these logins. |
| `[bridge info]`, `[bridge warning]` | Notices from the bridge, such as rate-limit warnings. |
| `[backup]` | A backup made, or why it failed. |
| `[push]` | A notification that couldn't be sent. |
| `[api]`, `[report]` | Unexpected errors in the API or in Pi Durable's background work. |

For the bridge's detail on how it drives Claude Code, set `CLAUDE_BRIDGE_DEBUG=1` and `CLAUDE_BRIDGE_DEBUG_PATH=/some/file` in the host's environment and restart it (`aludra serve` in a terminal is the easiest way).

## What doctor checks

`aludra doctor` runs every check at once and prints one line each. It never starts a Claude Code query.

| Area | Checks | When it isn't ok |
| --- | --- | --- |
| settings | The file loads and every setting is valid. | Lists each problem. |
| node | Node is 22.18 or later. | Install a newer Node, then `aludra service install`. |
| data | The data directory is writable. | Fix its permissions or `dataDir`. |
| host | Something answers on the CLI socket. | `aludra service install`, or `aludra serve`. |
| workspaces | Each root matches at least one project. | Fix the pattern; `aludra projects` shows the matches. |
| versions | Pi Durable and pi-claude-bridge are the pinned versions. | See [Upgrading Pi Durable or the bridge](#upgrading-pi-durable-or-the-bridge). |
| claude | `claude.path` runs, and Claude Code is logged in to a subscription. | `claude auth login`. A login that isn't a subscription is a warning: runs would be billed. |
| model | The bridge loads and has `model.id`. | Lists the models it has. |
| app | `api.users` is set, the app is built, Tailscale is installed and logged in, and `tailscale serve` points at `api.port`. | Prints the command to run, then the app's addresses once it's all there. |
| push | Apple's and Google's push services are reachable. | Notifications to those devices won't arrive. |
| service | Installed, running, and the unit matches this aludra, Node and settings file. On Linux, lingering is on. | Prints the command to run. |
| backup | The newest backup's age, and whether it's on the database's disk. | Warns when it's more than twice `backup.everyHours` old. |

## Backups

While it runs, the host checks a minute after start and every hour after that, and copies the database when the newest copy is older than `backup.everyHours` (default 24). It uses SQLite's online backup, so a copy is consistent even mid-run. Copies are named by their time (`aludra-20261013T091500Z.sqlite`), owner-only, and the newest `backup.keep` (default 7) are kept.

`aludra backup` makes one now, with or without the host running.

By default the copies sit in `backups/` beside the database, which protects against a bad upgrade or a corrupted file but not against losing the disk. Set `backup.dir` to another disk or a synced folder for that. Doctor says which you have.

Losing the database loses session history, ideas, approvals, picked colours and notification sign-ups. It doesn't lose code: sessions work in your project directories.

### Restoring

1. Stop the host: `aludra service uninstall` (or Ctrl+C where `aludra serve` runs).
2. Copy a backup over `aludra.sqlite` in the data directory.
3. Delete `aludra.sqlite-wal` and `aludra.sqlite-shm` beside it.
4. Start the host: `aludra service install`.

Devices signed up for notifications after the backup was made need turning on again.

## Upgrading

Pull and run `sh scripts/install.sh` ([setup.md](setup.md#update)). The lockfile pins every dependency, and the install uses it.

### Upgrading Pi Durable or the bridge

aludra's glue around pi-claude-bridge depends on the bridge's internals, and on how Pi Durable calls a provider. Both are pinned: Pi Durable and its lockstep packages at 1.1.0, the bridge at 0.9.2. Doctor fails when either differs. To move either one:

1. Change the version in a branch. Pi's packages move together: `chord`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-durable`, `pi-mcp`, `pi-telemetry` and `pi-tui` should all be the same exact version.
2. `pnpm check`. `test/bridge.test.ts` has a test for each fix in `src/bridge.ts`.
3. Run the live check against the real bridge and your own Claude Code login: `node --no-warnings scripts/live-check.ts`. It runs two sessions at once, a compaction, and a `kill -9` mid tool call with recovery, in a temporary directory. It spends a little of the subscription.
4. Update `PINNED` in `src/doctor.ts` and the versions in [architecture.md](architecture.md) and `docs/plan.md`.

## Troubleshooting

**The Mac app says 403.** Your Tailscale login isn't in `api.users` on that machine, or the request didn't come through `tailscale serve`. Add the login (exactly as `tailscale status` shows it) and restart the host.

**The Mac app says 502.** `tailscale serve` has nothing behind it: the host isn't running, or `tailscale serve` points at another port. `aludra doctor` says which.

**The browser shows "Forbidden".** As for 403. If you're on the right login, check you're using the `https://…ts.net/` address and not `127.0.0.1` directly, which has no Tailscale header.

**"The app isn't built; run pnpm build".** The host found no `dist/client`. Reinstall with `sh scripts/install.sh`, which builds it.

**The app shows an old version after an update.** The host reads the built app at start; restart it. On a phone, close the app fully and reopen it.

**The host stopped after I logged out (Linux).** `loginctl enable-linger "$USER"`.

**Doctor says the service runs a different aludra, Node or settings file.** The unit still names the old paths. `aludra service install`.

**A session says "Refused by the model's safeguards".** The model's classifier refused the request. They're sometimes false positives, triggered by file names or wording that sound like an attack. Send a reworded follow-up. The request ID is there to copy if you want to report it.

**A session says "Rate limited".** The subscription's usage window is spent. It resets on its own; tap Retry or send a follow-up after that.

**A session can't find `pnpm`, `cargo` or similar.** The service's PATH doesn't have it. Install the service again from a shell where `command -v` finds the tool.

**Notifications don't arrive on the iPhone.** They only work in the app added to the Home Screen, and must be turned on there. Use Test, then lock the phone within five seconds: iOS shows nothing for the web app while it's on screen. Check Focus and Do Not Disturb. `aludra doctor` checks the push services are reachable.

**The phone shows the old icon.** iOS keeps a Home Screen app's icon until you remove it and add it again.

**An old session's changes view shows a git error.** Git keeps the starting snapshot for two weeks at least; after a `git gc` an older session can lose it.
