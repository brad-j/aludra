# Using aludra

Each machine's host keeps its sessions. The web app (in any browser, on a phone or a computer), amyrlin (the optional macOS client) and the CLI are all windows onto the same sessions, so one started from a phone can be steered from a laptop and stopped from a terminal. A session keeps running when every app is closed, and picks up where it left off after the host restarts.

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

In the app, tap the new-session button, pick the project from the path at the top, and say what it should do. The picker lists recent projects first, then each folder group largest first; type to search by name.

"No project" heads the picker. A no-project session isn't about one repository: it works in a scratch directory of its own and reads anything else by absolute path. Its prompt tells it where your workspaces and agent histories are on this machine. It has no changes view and can't hold ideas.

From a terminal:

```sh
aludra ask --project site "Why does the build fail on main?"
```

A session is titled from its first message: at first its first line, then, a second or two later, a short title a model writes, such as "Feature backlog: shortcuts, editable ideas". The smallest model on hand writes it (Claude Haiku through Claude Code, or the cheapest OpenAI model you offer), as a one-off request on your plan. If no model answers, the first line stays. A title you set yourself is never replaced. Rename it from the session menu (the `⋯` in its header) in the web app, or from amyrlin's session menu or by double-clicking its header there.

### The transcript

Your messages, the answers, and each tool call in order. While a round of calls runs, each shows as a row; the running command shows the tail of its output at a fixed height. A finished round folds into one line, such as "read 4 files · ran 2 commands · edited 3", which opens to the calls. Tap a call to see its output, an edit's diff or a written file. Answers have a copy button.

When the conversation outgrows the model's context, Pi Durable compacts it: earlier messages are replaced by a summary, shown as "Earlier messages summarized".

Failures say what they are:

- **Refused by the model's safeguards**, with the request ID and Copy ID. These can be false positives; a reworded message may get through.
- **Rate limited**, when the subscription's window is used up.
- **The request failed**, for anything else, with Retry (which sends "Continue where you left off.").

### Steering, queueing and stopping

While a run goes, the composer's Steer/Queue toggle says how your next message is delivered:

- **Steer** goes in at the next tool boundary, so the run changes course without stopping.
- **Queue** waits until the run answers, then goes in as a follow-up.

Queued messages wait above the composer; tap one's take-back button to withdraw it before the run reaches it. When nothing is running, a message is a follow-up.

Stop (in the composer while a run goes, or Stop the run in the session menu) ends the run and drops queued messages. Nothing else runs until you send something. From a terminal: `aludra stop --session ID`.

Sending a message while a call waits for approval refuses that call, so the run can take your message instead.

### Model and thinking

The composer's model line shows the session's model, thinking level and how much of the context window the last request used, and what the session has cost if it used OpenRouter. Tap it to change the model or thinking; the next request uses them. Your pinned models (`model.choices`) are listed first; type to search every model of every provider the machine is signed in to, with prices where requests are billed. New sessions start with `model.id` and `model.thinking` from the settings.

### Images

Attach images with the image button (photos or the camera on a phone), or paste or drop them into the composer. A message takes up to 8. Each is scaled to at most 1568 px on its long side and sent as PNG or JPEG, which also converts a phone's HEIC photos. They show above your message in the transcript, and tap open full size. Images a tool returns, such as a screenshot the agent read, show under that call.

### Archiving

A session you're done with can be archived from its menu (`⋯`). It leaves its project in the drawer for a folded Archived group at the end, where you can still open it; the same menu brings it back. Nothing is deleted, and a run that's going carries on. A session whose project folder has gone away stays under the old project name until you archive it. In amyrlin, archive from a session's menu; on the command line, `aludra archive --session ID`.

## Ideas

An idea is a first message kept for later, filed under its project. In the new-session screen, write it and tap Idea instead of sending. Ideas show under their project in the drawer and on the new-session screen. Tap one to read it whole, then Start (which runs it as a new session in its project) or Delete. Ideas are text only.

## Approvals

Two kinds of shell command wait for you: `git push`, and `ssh`, `scp`, `rsync`, `sftp`, `mosh` or `sshfs` to a host in `approvals.hosts`. The session shows as waiting, and the request docks above the composer with the full command, Deny and Allow.

You can answer from:

- the web app, one tap from the notification;
- amyrlin;
- a terminal: `aludra approvals` lists them with their IDs, then `aludra approve ID` or `aludra deny ID`.

A request expires after `approvals.waitHours` (default 24), and the call is refused. Stopping the run or sending a new message cancels it. A restart doesn't: the call waits on the same request when the host comes back.

## Changes

The folder icon in a session's header counts the files the session changed; it and the path beside the title open the changes view. At the top, the total `+N −M`; below, each file biggest first with new, deleted or renamed noted, each opening to its diff.

The changes are the project's files now against a snapshot taken when the session started. They include the session's commits, and leave out whatever was already uncommitted when it started. A project inside a bigger repository sees only its own files. Projects outside git, no-project sessions, and sessions from before aludra recorded snapshots say why there's nothing to show. Git may drop a snapshot after two weeks (`git gc`), so very old sessions can lose their changes view.

## The drawer

Sessions grouped by machine and project, the project that most needs you first. Each row has its state, title, latest activity and age. Tap a project's name to fold its sessions away; a folded project still says when one of its sessions needs you or is working. Folding is remembered per browser.

Each project has a color hashed from its name. When two clash, pick another in amyrlin (a Color menu on the project's row); the web app shows picked colors but has no picker yet.

On a narrow screen the app opens on the drawer. From 60rem wide it's a column beside the session.

## Notifications

The host notifies your devices when a call waits for approval (after 2 seconds, if it still waits), and when a run ends done or failed. Nothing is sent about a session an app has on screen. Tapping a notification opens the session, with any approval above the composer.

Turn them on at the foot of the drawer, on each device: Turn on, Test, Turn off. Test sends five seconds after the tap, so you can lock a phone first. On iOS, only the app added to the Home Screen can get notifications, and iOS shows no banner for the web app while it's on screen. Focus or Do Not Disturb holds notifications on any device.

The host sends notifications through the browser maker's push service (Apple's, Google's or Mozilla's), encrypted to your device. amyrlin gets its updates over its own connection instead.

## amyrlin

[amyrlin](https://github.com/brad-j/amyrlin) is an optional native macOS client. It connects to every machine you add and shows all their sessions together. Everything above works there too, plus picking project colors. Its README covers installing it. Forking sessions isn't an aludra feature; amyrlin gets "unsupported" for it.

## The CLI

The commands that read or change sessions talk to the running host over its socket. [cli.md](cli.md) has them all. The useful ones day to day:

```sh
aludra                                  # every session and its transcript, live, read-only
aludra sessions                         # every session by project, with its state
aludra watch                            # what every session does, live, until Ctrl+C
aludra ask --session 12 "Now add tests" # a follow-up (or --steer while it runs)
aludra approvals                        # what waits for you
```
