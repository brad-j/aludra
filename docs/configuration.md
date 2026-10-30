# Configuration

aludra reads one JSON file at start. Most settings can also be changed from amyrlin, the API or `aludra config` while the host runs ([below](#changing-settings-while-the-host-runs)). A change made by hand in the file needs a restart: `aludra service install` rewrites the unit and restarts it, or restart it with `launchctl kickstart -k gui/$(id -u)/io.bradjohnson.aludra` on macOS and `systemctl --user restart aludra` on Linux.

## Where the file is

The first of these that's set:

1. `--config FILE` on the command line
2. the `ALUDRA_CONFIG` environment variable
3. `$XDG_CONFIG_HOME/aludra/config.json`, or `~/.config/aludra/config.json` when `XDG_CONFIG_HOME` isn't set (on macOS too)

`aludra init` writes the third. If you install the service with `--config`, the unit passes the same file to the host.

## A full example

```json
{
	"workspaces": [
		{ "name": "devbox", "roots": ["~/code/*", "~/work/*/*"] }
	],
	"api": { "users": ["you@example.com"], "port": 8724 },
	"model": {
		"id": "claude-opus-5-5",
		"thinking": "high",
		"choices": ["claude-opus-5-5", "claude-sonnet-5-5", "openai/gpt-6.1-sol"]
	},
	"claude": { "path": "claude" },
	"approvals": { "hosts": ["prod-db", "router"], "waitHours": 24 },
	"backup": { "dir": "/mnt/backup/aludra", "everyHours": 24, "keep": 7 },
	"dataDir": "~/aludra-data"
}
```

Only `workspaces` is required. `aludra serve` and `aludra service install` refuse to start while a setting is wrong, and `aludra doctor` lists every problem.

## Changing settings while the host runs

`POST /api/settings`, `aludra config set` and amyrlin's `settings.set` change these settings and save them to the file:

| Setting | Takes effect |
| --- | --- |
| `workspaces` | At once: projects are read from the new roots the next time they're listed. |
| `model.id`, `model.thinking` | For sessions started after the change. A default model has to be one the host has, unless its provider isn't loaded (Claude Code, when no Claude model was pinned at start), in which case it waits for a restart. |
| `model.choices` | At once, unless a choice's provider isn't loaded; then the whole list waits for a restart. |
| `approvals.hosts`, `approvals.waitHours` | At once, for calls made after the change. |
| `backup.dir`, `backup.everyHours`, `backup.keep` | At the next hourly check. |

`api.users`, `api.port`, `claude.path`, `claude.configDir` and `dataDir` change only in the file, followed by a restart. A wrong login or port would lock every client out with no way back in from one, a new data directory would strand the database, and the `claude` settings pick the program the host runs and the account it bills.

A change is checked the way the host checks the file at start, and refused whole if anything is wrong. The file is rewritten as formatted JSON with tab indents: every setting and any key aludra doesn't know stay, but your own formatting doesn't. If the file is a link, the file it points to is written.

A setting that's saved but not yet in effect is marked "after a restart" in the settings every client gets and in `aludra config`. That also covers a change made by hand in the file since the host started.

## Settings

### `workspaces`

A list of `{ "name", "roots" }`. Every directory a root matches is a project.

- `name` is the machine's name in amyrlin. Names must be unique.
- `roots` are path patterns. `~` is your home directory, and `*` matches any name within one path segment. Only directories match, never hidden ones. `~/code/*` makes each folder in `~/code` a project; `~/work/*/*` goes one level deeper.

A directory matched by two roots is one project. On the command line, `--project` takes a project's folder name, its parent and name (`clients/site`) when two share a name, or its full path. `aludra projects` lists what the roots match.

Projects are read from disk each time they're listed, so a new folder under a root shows up without a restart.

### `api`

- `users`: the Tailscale logins let in, such as `["you@example.com"]`. Default: none, and with none the API and amyrlin's endpoint stay off. Everyone listed sees and runs every session on this machine.
- `port`: the loopback port the API and amyrlin's endpoint listen on. Default `8724`. Point `tailscale serve` at the same port.

An old single `api.user` is an error rather than being ignored, since ignoring it would quietly turn the API off.

### `model`

- `id`: the default model for new sessions. Default `claude-opus-5-5`.
- `thinking`: the default thinking level: `off`, `minimal`, `low`, `medium`, `high` or `xhigh`. Default `high`.
- `choices`: the models pinned at the top of the model list clients get. Default Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1. The default `id` is added if it isn't listed. A choice its provider doesn't have is left out. Two choices can't share an ID, even from different providers.
- `provider`: the provider of a model written without one. `claude-bridge` (the default), `openai`, `openrouter` or `faux`. You won't normally set this; see `ALUDRA_MODEL` below for `faux`.

A model is `provider/id`, or a bare ID of `provider`:

| Provider | Models | Signed in with |
| --- | --- | --- |
| `claude-bridge` | Claude, through the Claude Code you installed: `claude-opus-5-5` | `claude auth login` |
| `openai` | OpenAI's, on your ChatGPT plan: `openai/gpt-6.1-sol` | `aludra login openai` |
| `openrouter` | Hundreds of models from many makers, billed per request: `openrouter/anthropic/claude-sonnet-5.5`, `openrouter/~google/gemini-pro-latest` | `aludra login openrouter` |

Pinning is only for convenience. The picker also searches every model of every provider this machine is signed in to: Claude Code's, the ones your ChatGPT account offers, and OpenRouter's whole catalog with prices. Any of them can run a session. Claude Code is only needed when a choice is a Claude model. A sign-in reaches a running host from the next time a picker opens; a change to `choices` needs a restart, like any other setting.

OpenRouter bills each request. aludra adds up what each session cost there, compaction summaries included, and shows it beside the session's context use, in amyrlin and the terminal, and `aludra sessions` shows the month's total. Answers on Claude Code and ChatGPT cost nothing here; they're on your plans. For a cap, set a credit limit on the key at OpenRouter.

Each session keeps its own model and thinking level, which you can change from amyrlin or the API at any time. The change applies to the session's next request.

### `claude`

- `path`: the Claude Code binary the bridge runs. Default `claude`, looked up on PATH. A path starting with `~/` is expanded.
- `configDir`: Claude Code's config directory, which holds its login, so it decides which Claude account sessions run on. Unset, the host uses its environment's `CLAUDE_CONFIG_DIR`, else `~/.claude`. Set it when you keep more than one Claude Code login, for example `"~/.claude-personal"`, and log in there first with `CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login`. The host sets `CLAUDE_CONFIG_DIR` for itself at start, so it doesn't depend on the shell the service was installed from.

Point `path` at Claude Code itself, not at a wrapper script that sets `CLAUDE_CONFIG_DIR`. The bridge writes Claude Code's session files from inside the host, under the host's own config directory, and Claude Code resumes from its own; when the two differ, every turn fails with "No conversation found with session ID".

aludra never uses the copy of Claude Code that ships inside the Agent SDK. It runs the one you installed and logged in to.

### `approvals`

- `hosts`: host names whose remote commands wait for your approval. A shell command running `ssh`, `scp`, `rsync`, `sftp`, `mosh` or `sshfs` with an argument naming one of these (`host`, `user@host`, `host:path` or `host.domain`) waits. Default: none. `git push` always waits, whatever this says.
- `waitHours`: how long a request waits before it expires and the call is refused. Default `24`.

[security.md](security.md#permissions) covers what runs without asking.

### `backup`

- `dir`: where copies of the database go. Default `backups/` in the data directory. Put it on another disk or a synced folder if you want the copies to survive this disk failing.
- `everyHours`: how old the newest copy may get before the host makes another. Default `24`.
- `keep`: how many copies to keep, newest first. Default `7`.

[operations.md](operations.md#backups) covers backups and restoring.

### `dataDir`

Where the database, keys, scratch directories and uploaded videos go. Default `~/Library/Application Support/aludra` on macOS, and `$XDG_DATA_HOME/aludra` (or `~/.local/share/aludra`) on Linux.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ALUDRA_CONFIG` | The settings file, when `--config` isn't given. |
| `ALUDRA_DATA_DIR` | Replaces the data directory, over `dataDir` in the file. |
| `ALUDRA_MODEL=faux` | Runs a scripted model with no network and no Claude Code, for tests and trying the host. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Move the default settings and (on Linux) data directories. |
| `CLAUDE_CONFIG_DIR` | Claude Code's config directory when `claude.configDir` isn't set. `claude.configDir` replaces it. |
| `CLAUDE_BRIDGE_DEBUG=1`, `CLAUDE_BRIDGE_DEBUG_PATH` | The bridge's detailed log of its Claude Code sessions. |

## The data directory

| Path | What |
| --- | --- |
| `aludra.sqlite` | Every session, idea, approval and setting clients change: one Pi Durable database. `-wal` and `-shm` sit beside it while the host runs. |
| `aludra.sock` | The Unix socket the CLI talks to the host over. Owner-only. |
| `push-keys.json` | The key aludra signs notifications with, made on first start. Owner-only. |
| `credentials.json` | Sign-ins to providers other than Claude Code: the ChatGPT sign-in `aludra login openai` makes, with its refreshed tokens, and the key `aludra login openrouter` gets. Owner-only. |
| `device-id` | This installation's ID, sent to OpenAI when signing in with ChatGPT so it can tell your machines apart. Not a secret. |
| `bridge/` | The bridge's own settings (`claude-bridge.json`, with `claude.path`) and a small module that points the bridge there instead of at pi's own settings. |
| `scratch/<id>/` | The working directory of each no-project session. |
| `uploads/<id>/` | Videos sent with a session's messages, deleted 14 days after they arrive. |
| `backups/` | Copies of the database, unless `backup.dir` says otherwise. |
| `tailscale/` | Only with aludra's own Tailscale node ([setup.md](setup.md#optional-a-tailscale-node-of-aludras-own-linux)). |

The directory is created owner-only (`0700`), and the service runs with a `0077` umask.

## Project context and skills

Sessions get the same instructions the pi coding agent would, found with its own loaders: `~/.pi/agent/AGENTS.md`, then `AGENTS.md` or `CLAUDE.md` in each directory from `/` down to the project, and skills from `~/.pi/agent/skills` and the project's `.pi/skills`. They're read again before every request, so an edit reaches the session's next request without a restart.
