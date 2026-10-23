# The aludra command

```
aludra [--config FILE] COMMAND
```

`--config` names the settings file for any command ([configuration.md](configuration.md#where-the-file-is)). `aludra --help` prints the summary.

Commands fall into two groups. `init`, `service`, `serve`, `login`, `logout`, `projects`, `config`, `backup` and `doctor` work on their own. The rest talk to the running host over its Unix socket in the data directory, and print "can't reach the aludra server" if it isn't running.

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

### `aludra login openai | openrouter` and `aludra logout openai | openrouter`

`login openai` signs this machine in with ChatGPT, so OpenAI's models run on your ChatGPT plan rather than an API key. `login openrouter` signs in to OpenRouter, which gives aludra an API key of its own; its models are billed per request. Either way, the models are then in the apps' model picker. It prints an address to open in a browser. If the browser is on this machine, the sign-in finishes on its own. If it's elsewhere (you're on SSH), the browser ends on a `http://127.0.0.1:1455/auth/callback?...` page that fails to load: copy that address from the address bar and paste it at the prompt. Afterwards, for OpenAI, it lists the models your account offers, written as choices you can pin in the settings. OpenRouter's flow calls back to a random loopback port the same way.

The sign-in is kept in `credentials.json` in the data directory, and the running host uses it from its next request. Sign in on each machine separately. `logout` removes it from this machine; OpenRouter's key stays valid until you delete it on OpenRouter's site. Claude has no `aludra login`: Claude Code keeps its own, from `claude auth login`.

### `aludra doctor`

Checks the settings and everything the host needs, without starting it or spending anything. Exits 1 if any check failed. [operations.md](operations.md#what-doctor-checks) explains each check.

## Working with sessions

### `aludra`

```
aludra [--session ID]
```

With no command, in a terminal, opens a read-only view of the host: every session on the left, grouped and ordered as in the app's drawer, and the selected session's transcript on the right, following new output as it streams. The line at the foot has the session's state, model, thinking level and context use, and its cost if it used OpenRouter. A session waiting for approval shows the call and the `approve` and `deny` commands.

| Key | Does |
| --- | --- |
| `↑` `↓` or `k` `j` | The previous or next session. |
| `PgUp` `PgDn`, mouse wheel | Scroll the transcript. Scrolling up stops following; `End` or `G` follows again. |
| `Home` or `g` | The start of the transcript. |
| `q` or `Ctrl+C` | Quit. |

`--session` opens that session first; otherwise the one that most needs you. Nothing here changes a session: answer approvals, steer and stop from the app or the commands below. If the host restarts, the view reconnects on its own. Piped, `aludra` prints the usage instead. `NO_COLOR` turns color off.

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

Lists sessions the way the app's drawer does: grouped by project, the project that most needs you first, and within each, sessions waiting for you, then running, then the rest, newest first. Each session has its state mark, ID, title and how long since it last did something, with its latest activity under it (the running command, the answer's first line, or the failure).

| Mark | State |
| --- | --- |
| `◆` | Waiting for your approval. |
| `◐` | Running. |
| `⊘` | Failed. |
| `□` | Stopped. |
| `✓` | Done. |
| `·` | Not started. |

A session that used OpenRouter shows what it cost before its age, and the month's OpenRouter total is at the foot.

In a terminal, project names are in their project color (the same one the apps show, including a picked one), waiting is amber, running violet and failed red, and long titles are cut to the terminal's width. Piped, the output is plain text at 100 columns. `NO_COLOR` turns color off, and `FORCE_COLOR` turns it on when piped.

### `aludra stop --session ID`

Stops a session's run.

### `aludra retitle`

Has a model write titles for sessions that still have their first message's first line: ones from before titles were written, or whose title request failed. Sessions you renamed are left alone. Prints each new title beside the old one. Run it again any time; it only picks up sessions that still need one.

### `aludra archive --session ID` and `aludra unarchive --session ID`

Hides a session from the lists (the apps' drawers, `aludra sessions`, the terminal UI), or brings it back. Nothing is deleted, and a running session keeps running. `aludra sessions` counts the archived ones at its foot; `aludra --session ID` still opens one.

### `aludra approvals`

Lists calls waiting for approval, oldest first, with their IDs.

### `aludra approve ID` and `aludra deny ID`

Answers one. Exits 1 if nothing with that ID is waiting (it was answered, expired or canceled).

## Other

### `aludra projects`

Lists what the workspace roots match: each project's name, workspace and directory.

### `aludra config`

```
aludra config
aludra config set KEY VALUE...
aludra config unset KEY
```

With no arguments, lists every setting, its value and where the settings came from. Each is marked `default` when the file doesn't name it, `file only` when it can't be changed here, and `after a restart` when the running host doesn't have the saved value yet.

`set` changes one setting and `unset` puts it back to its default. A list takes each word as an entry (`aludra config set approvals.hosts db router`), or JSON; `workspaces` takes JSON:

```sh
aludra config set workspaces '[{"name": "code", "roots": ["~/code/*", "~/work/*/*"]}]'
aludra config set model.thinking medium
aludra config unset backup.dir
```

When the host is running, the change goes through it and takes effect at once where it can. Otherwise it's written straight to the file for the next start. The settings it can change, and when each takes effect, are in [configuration.md](configuration.md#changing-settings-while-the-host-runs).

### `aludra backup`

Copies the database into the backup directory now and prints the file's path. Works whether or not the host is running.
