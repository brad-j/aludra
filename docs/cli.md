# The aludra command

```
aludra [--config FILE] COMMAND
```

`--config` names the settings file for any command ([configuration.md](configuration.md#where-the-file-is)). `aludra --help` prints the summary.

Commands fall into two groups. `init`, `service`, `serve`, `projects`, `backup` and `doctor` work on their own. The rest talk to the running host over its Unix socket in the data directory, and print "can't reach the aludra server" if it isn't running.

## Setting up

### `aludra init`

```
aludra init [--root PATTERN]... [--user LOGIN]... [--name NAME] [--yes] [--force]
```

Writes the settings file, asking for the project folders, the Tailscale logins let in, and the machine's name, each with a guess ([setup.md](setup.md#write-the-settings)). Flags answer without asking; `--root` and `--user` may be repeated. `--yes` takes the guesses for anything not given, and is required when there's no terminal to ask in. `--force` overwrites an existing file. Prints what to run next and the machine's addresses.

### `aludra service install | uninstall | status`

Runs the host in the background and at login: a launchd agent on macOS, a systemd user unit on Linux.

- `install` writes the unit for this aludra, this Node and this shell's PATH, and (re)starts it. Run it again after an upgrade or a switch of Node. It refuses while the settings have errors, or while an `aludra serve` runs outside the service.
- `uninstall` stops the host and removes the unit.
- `status` prints the service's state. Exits 0 when it's running, 1 when it's installed but not running, and 3 when it isn't installed.

### `aludra serve`

Runs the host in the foreground: the sessions, the CLI's socket, and (with `api.users` set) the app and its API on `127.0.0.1:<api.port>`. Ctrl+C stops it; running sessions continue at the next start. The service runs this command. Use it directly to watch the host's log in a terminal, or on a platform without launchd or systemd.

### `aludra doctor`

Checks the settings and everything the host needs, without starting it or spending anything. Exits 1 if any check failed. [operations.md](operations.md#what-doctor-checks) explains each check.

## Working with sessions

### `aludra ask`

```
aludra ask --project NAME "MESSAGE"
aludra ask --session ID [--steer] "MESSAGE"
```

With `--project`, starts a session in that project; with `--session`, sends an existing session a follow-up, or a steer with `--steer` while it runs. Either way it prints the run as it happens, and exits 0 when the run ends with an answer, 1 otherwise.

`--project` takes the project's folder name, `parent/name`, or its path; `aludra projects` lists them. Words after the flags are joined into the message, so quoting is only needed for the shell's sake.

Leaving with Ctrl+C doesn't stop the run. To reattach to a follow-up, rerun it with the same `--id REQUEST`: the host finds the message it already has instead of sending it twice, and prints the answer when it comes. Without `--id`, each `ask` gets a fresh one.

Lines in the output:

| Prefix | Meaning |
| --- | --- |
| `·` | A tool call (`· bash pnpm test`), a retry, a compaction, or a stop. |
| `?` | A call waiting for approval, with the `approve` and `deny` commands to answer it. |
| `!` | A failure: a refusal, a bridge error, or a failed task. |
| none | The answer. |

### `aludra watch [--session ID]`

Prints what every session does, prefixed `[id project]`, until Ctrl+C. New sessions are picked up as they start, and pending approvals are listed on connect. With `--session`, follows one session without prefixes.

### `aludra sessions`

Lists sessions grouped by project, each with its ID, state (`running`, `waiting` or `idle`), age and title.

### `aludra stop --session ID`

Stops a session's run.

### `aludra approvals`

Lists calls waiting for approval, oldest first, with their IDs.

### `aludra approve ID` and `aludra deny ID`

Answers one. Exits 1 if nothing with that ID is waiting (it was answered, expired or cancelled).

## Other

### `aludra projects`

Lists what the workspace roots match: each project's name, workspace and directory.

### `aludra backup`

Copies the database into the backup directory now and prints the file's path. Works whether or not the host is running.
