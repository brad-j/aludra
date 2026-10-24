# Using aludra

Each machine's host keeps its sessions. amyrlin (the optional macOS client), the CLI and anything else on the [API](api.md) are all windows onto the same sessions, so one started from amyrlin can be steered and stopped from a terminal. aludra has no web app. A session keeps running when every client is closed, and picks up where it left off after the host restarts.

## Sessions

A session is one conversation with the agent, working in one project directory. It runs Claude Code with aludra's tools (read, write, edit and bash), the project's `AGENTS.md` or `CLAUDE.md`, and your skills. Inside the project it works without asking; `git push` and remote commands to listed hosts wait for you ([Approvals](#approvals)).

A session's state is one of:

| State | Meaning |
| --- | --- |
| running | A request or tool call is in progress. |
| waiting | A call waits for your approval. |
| done | The last run finished with an answer. |
| failed | The last run ended in an error or a refusal. |
| stopped | You stopped the last run. |
| idle | Nothing has run yet, or nothing is happening. |

### Starting one

Start one in amyrlin, from a terminal, or with `POST /api/sessions`. A no-project session isn't about one repository: it works in a scratch directory of its own and reads anything else by absolute path. Its prompt tells it where your workspaces and agent histories are on this machine. It has no changes view and can't hold ideas.

From a terminal:

```sh
aludra ask --project site "Why does the build fail on main?"
```

A session is titled from its first message: at first its first line, then, a second or two later, a short title a model writes, such as "Feature backlog: shortcuts, editable ideas". The smallest model on hand writes it (Claude Haiku through Claude Code, or the cheapest OpenAI model you offer), as a one-off request on your plan. If no model answers, the first line stays. A title you set yourself is never replaced. Rename it from amyrlin's session menu or by double-clicking its header there, or with `POST /api/sessions/:id/title`.

### The transcript

Your messages, the answers, and each tool call in order, with the running command's output as it streams. `aludra watch` prints it live in the terminal.

When the conversation outgrows the model's context, Pi Durable compacts it: earlier messages are replaced by a summary, shown as "Earlier messages summarized".

Failures say what they are:

- **Refused by the model's safeguards**, with the request ID. These can be false positives; a reworded message may get through.
- **Rate limited**, when the subscription's window is used up.
- **The request failed**, for anything else. Sending "Continue where you left off." retries it.

### Steering, queueing and stopping

While a run goes, a message is delivered one of two ways:

- **Steer** goes in at the next tool boundary, so the run changes course without stopping (`aludra ask --session ID --steer`).
- **Queue** waits until the run answers, then goes in as a follow-up.

A queued message can be withdrawn before the run reaches it (`POST /api/sessions/:id/withdraw`). When nothing is running, a message is a follow-up.

Stopping ends the run and drops queued messages. Nothing else runs until you send something. From a terminal: `aludra stop --session ID`.

Sending a message while a call waits for approval refuses that call, so the run can take your message instead.

### Model and thinking

Each session has a model and thinking level; a change applies from the next request (`POST /api/sessions/:id/agent`). Your pinned models (`model.choices`) come first, and any model of any provider the machine is signed in to can be picked, with prices where requests are billed. `aludra sessions` shows what a session has cost if it used OpenRouter. New sessions start with `model.id` and `model.thinking` from the settings.

### Images

A message takes up to 8 images: PNG, JPEG, GIF or WebP, at most 5 MB each. amyrlin scales them down before sending. Images a tool returns, such as a screenshot the agent read, stay in the transcript with that call.

### Archiving

A session you're done with can be archived: it leaves the lists, and unarchiving brings it back. Nothing is deleted, and a run that's going carries on. A session whose project folder has gone away stays under the old project name until you archive it. In amyrlin, archive from a session's menu; on the command line, `aludra archive --session ID`.

## Ideas

An idea is a first message kept for later, filed under its project, through the API: `POST /api/ideas` saves one, `/api/ideas/:id/start` runs it as a new session in its project, and `/api/ideas/:id/delete` drops it. Ideas are text only.

## Approvals

Two kinds of shell command wait for you: `git push`, and `ssh`, `scp`, `rsync`, `sftp`, `mosh` or `sshfs` to a host in `approvals.hosts`. The session shows as waiting, with the full command.

You can answer from:

- amyrlin;
- a terminal: `aludra approvals` lists them with their IDs, then `aludra approve ID` or `aludra deny ID`.

amyrlin can also allow one always: that session then runs the same kind of call (`git push`, or `ssh` to that host) without asking. Other sessions still ask. amyrlin's inspector lists a session's rules, and any can be taken back.

A request expires after `approvals.waitHours` (default 24), and the call is refused. Stopping the run or sending a new message cancels it. A restart doesn't: the call waits on the same request when the host comes back.

## Changes

`GET /api/sessions/:id/changes` gives the files a session changed, with the total `+N −M` and each file biggest first, new, deleted or renamed noted; `/changes/diff?path=` gives one file's diff.

The changes are the project's files now against a snapshot taken when the session started. They include the session's commits, and leave out whatever was already uncommitted when it started. A project inside a bigger repository sees only its own files. Projects outside git, no-project sessions, and sessions from before aludra recorded snapshots say why there's nothing to show. Git may drop a snapshot after two weeks (`git gc`), so very old sessions can lose their changes.

## Project colors

Each project has a color hashed from its name, the same in amyrlin and the CLI. When two clash, pick another in amyrlin (a Color menu on the project's row) or with `POST /api/projects/color`.

## Settings

`aludra config set`, amyrlin's `settings.set` and `POST /api/settings` change the host's settings: workspaces and their roots, the default model and thinking, pinned models, approval hosts and backups. Most apply at once, so a new root's projects are there straight away; any that need a restart say so. The Tailscale logins, the port, Claude Code's path and the data directory change only in the settings file. [configuration.md](configuration.md#changing-settings-while-the-host-runs) has the details.

## Notifications

The host notifies your devices when a call waits for approval (after 2 seconds, if it still waits), and when a run ends done or failed. Nothing is sent about a session a client on `/api/live` says it has on screen. Each carries the session's path (`/s/ID`) for the client to open.

They go by Web Push, to devices signed up with `POST /api/push/subscribe`, through the browser maker's push service (Apple's, Google's or Mozilla's), encrypted to the device. aludra serves no page or service worker to sign a device up, so this takes a client of your own; `POST /api/push/test` sends a test five seconds later. amyrlin gets its updates over its own connection instead.

## amyrlin

[amyrlin](https://github.com/brad-j/amyrlin) is an optional native macOS client. It connects to every machine you add and shows all their sessions together. It reaches the same sessions, approvals, settings and project colors as the API. Its README covers installing it. Forking sessions isn't an aludra feature; amyrlin gets "unsupported" for it.

## The CLI

The commands that read or change sessions talk to the running host over its socket. [cli.md](cli.md) has them all. The useful ones day to day:

```sh
aludra                                  # every session and its transcript, live, read-only
aludra sessions                         # every session by project, with its state
aludra watch                            # what every session does, live, until Ctrl+C
aludra ask --session 12 "Now add tests" # a follow-up (or --steer while it runs)
aludra approvals                        # what waits for you
```
