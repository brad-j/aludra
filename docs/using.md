# Using aludra

Each machine's host keeps its sessions. loial (the desktop client), the CLI and anything else on the [API](api.md) are all windows onto the same sessions, so one started from loial can be steered and stopped from a terminal. aludra has no web app. A session keeps running when every client is closed, and picks up where it left off after the host restarts.

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

Start one in loial, from a terminal, or with `POST /api/sessions`. A no-project session isn't about one repository: it works in a scratch directory of its own and reads anything else by absolute path. Its prompt tells it where your workspaces and agent histories are on this machine. It has no changes view.

From a terminal:

```sh
aludra ask --project site "Why does the build fail on main?"
```

A session is titled from its first message: at first its first line, then, a second or two later, a short title a model writes, such as "Feature backlog: shortcuts, editable ideas". The smallest model on hand writes it (Claude Haiku through Claude Code, or the cheapest OpenAI model you offer), as a one-off request on your plan. If no model answers, the first line stays. A title you set yourself is never replaced on its own. When a session has moved on, have the title written again from the whole conversation: `aludra retitle --session ID`, `POST /api/sessions/:id/retitle` or `conversations.retitle` on `/app`. That replaces any title, yours too. Rename it from a client's session menu or by double-clicking its header there, or with `POST /api/sessions/:id/title`.

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

### Subagents

A session can hand a self-contained task to a subagent with its `agent` tool: exploring a codebase, reading many files, or a separate piece of the work. The subagent is a fresh agent with the session's tools, directory and rules, on the model `subagents.model` names (Sonnet by default), and only its final answer comes back to the session, so the detail doesn't fill the session's context. The model decides when to use one, and it can start several at once. You can ask for it too ("use subagents to survey each package").

A subagent can't start subagents of its own. Its approvals are the session's: a `git push` it makes waits for you as the session's would, and stopping the session stops it. Subagents aren't sessions, so they're not in the lists. A client can show the agent call in the session's transcript, and open the subagent's own transcript from it. Each subagent's spending counts toward its session's.

### The web

Every session has `web_search`, which asks Tavily, and `fetch_url`, which reads one page as text with its links, 20,000 characters at a time. Search needs a Tavily key; fetching a URL you wrote in a message, or one a search returned, needs nothing more. Any other URL, such as a link the agent found on a page, is first put to a reviewer (Jev, through OrcaRouter) that sees your last few messages and the URL, never the page, and is fetched only when it judges the fetch safe; without its key those are refused, and the agent is told to search instead or ask you for the link. `fetch_url` reads public addresses only. Commands the agent runs in bash reach the network as before, unreviewed. [configuration.md](configuration.md#web-keys) has where the keys go.

### Pages

Ask for a chart, a table, a diagram or a mockup ("show the build times as a chart") and the agent can publish a page: a self-contained HTML document that loial shows in the session, above the written answer. Local images the page names are copied into it, so it keeps working after the files move. A page can run scripts but can't load anything from the network, so charts are drawn inline. Pages are kept with their session. From a terminal, `aludra page --session ID N` writes page N to a file and prints its path, to open in a browser.

### Images

A message takes up to 8 images: PNG, JPEG, GIF or WebP, at most 5 MB each. Clients scale them down before sending. Images a tool returns, such as a screenshot the agent read, stay in the transcript with that call.

### Videos

A client can send a short video, such as a screen recording of a bug, as a 720p MP4 of at most 40 MB, with a few frames from it. The model sees the frames straight away; the video is saved on the host, and the message tells the agent where, so it can pull more frames with ffmpeg if the host has it (`aludra doctor` says). The host keeps a video for 14 days, then deletes it. The frames stay in the transcript.

### Files and long messages

A message can carry files of any kind: a log, a PDF, a CSV, a zip, at most 20 and 25 MB together. The host saves each on the machine and the message tells the agent where, so it opens them with its own tools. Text longer than 32 KB, such as a pasted log, is saved the same way: the message keeps its start, and the agent reads the rest from the file. Like videos, these are deleted 14 days after they arrive. From a terminal, `aludra ask --session ID "$(cat build.log)"` goes the same way when the log is long.

### Archiving

A session you're done with can be archived: it leaves the lists, and unarchiving brings it back. Nothing is deleted, and a run that's going carries on. A session whose project folder has gone away stays under the old project name until you archive it. In loial, archive from a conversation's ⋯ menu; on the command line, `aludra archive --session ID`.

A project can be archived too, to take it out of clients' lists and `aludra projects` without touching its folder or sessions: `aludra archive --project NAME`, and `aludra unarchive --project NAME` to bring it back.

The host also archives sessions in a project on its own once they've been idle for `archive.afterDays` (default 3) with nothing waiting for your approval. Sessions with no project, which are conversations rather than tasks, stay until you archive them. It checks a minute after start and hourly, whether or not any client is open. A session you bring back from the archive is kept: it stays in the lists however long it sits, until you archive it again. Set `archive.afterDays` to 0 to turn it off.

## Setup notes

Sessions with no project on this machine can read notes you keep about your own setup: which machines you have, what runs where, how your projects connect. Put Markdown files in `setup/` in the data directory, or the directory [`setup.dir`](configuration.md#setup) names. `README.md` is a short map that goes in the prompt of every such session (up to 2,000 characters), with the list of topics after it; every other `<topic>.md` (lowercase letters, digits and `-`) is a note the agent reads with `read_setup` when a question needs it. They're read at each turn, so edits apply at once. Links and other files are ignored. Without any notes, sessions get neither the map nor the tool. Sessions in a project and sandbox sessions never get them.

## Executor

[Executor](https://executor.sh) is one MCP server in front of your connected accounts (Gmail, Calendar, GitHub and others). Sign in once from your app's settings (`executor.signIn` on `/app`): the app opens Executor's sign-in page, and when you allow it the browser comes back to this host at `https://<machine>/api/executor/callback` through `tailscale serve`, so it works from any device on your tailnet. The host keeps the grant, refreshes it as needed, and connects with it again after a restart. Once signed in, no-project sessions on this machine get Executor's tools as `executor_search`, `executor_call` and the rest; sessions in a project and sandbox sessions never do. Executor asks for approval on its own page: a call that needs it (sending mail, say) comes back with a link the agent gives you, and you decide there. Signing out (`executor.signOut`) forgets the grant here; Executor keeps the authorization until you revoke it on its side.

## Ideas

With [`ideas.dir`](configuration.md#ideas) set, the host reads and writes your ideas repository: Markdown in a Git clone, one file per idea under `ideas/`, one-liners in `inbox.md`, and an `INDEX.md` the host writes after every change. Every idea has a number from one sequence, captures included, and keeps it when it's promoted to a file; a deleted idea's number isn't given out again.

- **Local first.** Each change is a commit in the clone at once, with no network. A sync then fetches, rebases those commits onto the remote and pushes, in the background, and again after 15 s, 30 s, 1, 2 and then every 5 minutes while commits wait. A conflict in `INDEX.md` is settled by writing it again, and `inbox.md` merges both sides' lines; any other conflict stops syncing, says which files, and waits for you to sort it out in the clone. Two machines can give out the same number between syncs; the sync after says which, and renumbering is by hand. A clone with uncommitted changes can be read but not written.
- **In sessions.** A no-project session on this machine gets `list_ideas`, `read_idea`, `capture`, `save_idea`, `update_idea` and `set_status`. Sessions in a project, and sandbox sessions, don't. A write's result carries its commit and diff, so a client can show it and undo it. Say "save this" to have the agent write a distilled idea file, which then lists the session in its `sessions:` as `<machine>/<session>`, and the session is about that idea from then on.
- **Brainstorms.** `ideas.brainstorm` starts a no-project session about an idea, titled "Brainstorm: #N …", with the idea file in its prompt as it is at each message. Sending "Save this chat to idea #N." asks it to fold what the session settled into the file with one change, or to say nothing was settled.
- **Projects.** `ideas.makeProject` makes a project from an idea, its next steps and open questions becoming the first plan items, then sets the idea to `doing` with the repository in `project:`. It needs [`newProjects`](configuration.md#newprojects).

Clients reach all of it through `/app` ([api.md](api.md#ideas)).

## Approvals

Two kinds of shell command wait for you: `git push`, and `ssh`, `scp`, `rsync`, `sftp`, `mosh` or `sshfs` to a host in `approvals.hosts`. The session shows as waiting, with the full command.

You can answer from:

- loial;
- a terminal: `aludra approvals` lists them with their IDs, then `aludra approve ID` or `aludra deny ID`;
- `POST /api/approvals/:id` with `{ allow }`.

A client can also allow one always: that session then runs the same kind of call (`git push`, or `ssh` to that host) without asking. Other sessions still ask. A session's summary lists its rules (`alwaysAllowed`), and `approval.forget` takes one back.

A request expires after `approvals.waitHours` (default 24), and the call is refused. Stopping the run or sending a new message cancels it. A restart doesn't: the call waits on the same request when the host comes back.

## Changes

`GET /api/sessions/:id/changes` gives the files a session changed, with the total `+N −M` and each file biggest first, new, deleted or renamed noted; `/changes/diff?path=` gives one file's diff.

The changes are the project's files now against a snapshot taken when the session started. They include the session's commits, and leave out whatever was already uncommitted when it started. A project inside a bigger repository sees only its own files. Projects outside git, no-project sessions, and sessions from before aludra recorded snapshots say why there's nothing to show. Git may drop a snapshot after two weeks (`git gc`), so very old sessions can lose their changes.

### Searching

`aludra search WORDS...`, `GET /api/search?q=` and `messages.search` on `/app` find messages and answers with every word you give, across every session (archived ones too) or in one. The index holds what you and the agent said, not tool calls or command output, and keeps up as sessions run.

### Checkpoints

As each turn starts, a project session in git takes a checkpoint: a snapshot of the project's files, like the one its changes start from. A turn's changes run from its checkpoint to the next one (or to now, for the latest), so you can see what one turn did: `aludra checkpoints --session ID`, `GET /api/sessions/:id/checkpoints` and `/checkpoints/:n/changes`.

Restoring a checkpoint puts the project's files back to how they were when that turn started: changed and deleted files are written back, and files made since are deleted. Ignored files, the index, branches and commits stay as they are, so a commit the session made stays in history; only the files go back. It's refused while the session runs or waits for an approval. Before it writes anything, it takes a checkpoint of the files as they are, so a restore is undone by restoring that one; the CLI prints the command. The session's next message tells the agent which files were put back.

From a terminal: `aludra restore --session ID CHECKPOINT`.

## Project colors

Each project has a color hashed from its name, the same in every client and the CLI. When two clash, pick another with `POST /api/projects/color`.

## Settings

`aludra config set`, `settings.set` on `/app` and `POST /api/settings` change the host's settings: workspaces and their roots, the default model and thinking, pinned models, approval hosts and backups. Most apply at once, so a new root's projects are there straight away; any that need a restart say so. The Tailscale logins, the port, Claude Code's path and the data directory change only in the settings file. [configuration.md](configuration.md#changing-settings-while-the-host-runs) has the details.

## Notifications

The host notifies your devices when a call waits for approval (after 2 seconds, if it still waits), and when a run ends done or failed. Nothing is sent about a session a client on `/api/live` says it has on screen. Each carries the session's path (`/s/ID`) for the client to open.

They go by Web Push, to devices signed up with `POST /api/push/subscribe`, through the browser maker's push service (Apple's, Google's or Mozilla's), encrypted to the device. aludra serves no page or service worker to sign a device up, so this takes a client of your own; `POST /api/push/test` sends a test five seconds later. loial gets its updates over its own connection instead.

## Other agents (MCP)

`/mcp` lets an agent aludra didn't start, such as Claude Code in a terminal on your Mac, list this machine's projects and sessions, read a session's transcript and search what was said. With `mcp.write` on in the settings file, it can also start a session in a project with a task, send one a message and stop it, and archive or unarchive sandbox sessions, so work can be handed from one machine to another: "start a session in site on egwene to fix the build, then check on it." With `mcp.sandboxOnly` too, those sessions all run in sandboxes, and the agent can message or stop only sandbox sessions. With `mcp.worktreeOnly` instead, each works in a git worktree of its own on a `worktree/N` branch that can't push, and always in a project; you merge the branch when you're happy with it. `start_session` and `send_message` take an optional `model` and `effort` (thinking level) for that turn on. It can read a project's plan with `read_plan`, but not change it, and it can't ship a session or make a project; the apps do those over `/app`. [setup.md](setup.md#connect-a-client) has the command to add it.

## loial

loial is the desktop client, for Mac and Linux. It connects to every machine you add and shows all their sessions together, as tasks (in a sandbox or a git worktree) and read-only chats, and ships a task's work. It speaks the `/app` endpoint and uses only what its `docs/protocol.md` lists. Forking sessions isn't an aludra feature.

## The CLI

The commands that read or change sessions talk to the running host over its socket. [cli.md](cli.md) has them all. The useful ones day to day:

```sh
aludra                                  # every session and its transcript, live, read-only
aludra sessions                         # every session by project, with its state
aludra watch                            # what every session does, live, until Ctrl+C
aludra ask --session 12 "Now add tests" # a follow-up (or --steer while it runs)
aludra approvals                        # what waits for you
```
