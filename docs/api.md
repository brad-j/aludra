# API

The host has four ways in: the HTTP and WebSocket API, amyrlin's protocol at `/amyrlin`, MCP at `/mcp` for other agents, and the CLI's Unix socket. All of them reach the same sessions. There's no web app. The types below are in `src/api-types.ts`, which a client in TypeScript can import.

## The HTTP API

Served on `127.0.0.1:<api.port>`, and reached through `tailscale serve`.

### Requests

Every request needs a `Tailscale-User-Login` header naming a login in `api.users`; otherwise 403. POSTs must send `Content-Type: application/json`, and an `Origin`, if present, must be this host. Bodies are JSON; message bodies may be up to 64 MB (for images), everything else up to 200 KB.

Errors come back as `text/plain` with a status: 400 for a malformed body or a bad value, 403 for identity or origin, 404 for a missing session, project, idea or model, 409 for an approval that isn't waiting, 413 for a body too large, 500 for anything else (also logged by the host).

### Endpoints

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/bootstrap` | | `Bootstrap`: the login, machine name, projects, the pinned models, every model the signed-in providers have (`catalog`, with prices where billed), thinking levels and defaults. |
| `POST /api/sessions` | `{ project, text, images?, files?, model?, thinking?, requestId?, sandbox? }` | `{ id }`. An empty `project` makes a no-project session. Needs text, images or files. `sandbox: true` runs its tools in a sandbox of its own (see the CLI's [Sandboxes](cli.md#sandboxes)); the request waits while a project's template is made. |
| `POST /api/sessions/:id/messages` | `{ text, images?, files?, mode: "steer" \| "followUp", requestId? }` | `{ submission }`, for withdrawing it. |
| `POST /api/sessions/:id/stop` | `{}` | `{}` |
| `POST /api/sessions/:id/title` | `{ title }` | `{ title }`, whitespace folded, 1 to 200 characters. |
| `POST /api/sessions/:id/retitle` | `{}` | `{ title, written }`. A model writes the title again from the whole conversation, replacing any title, one set by hand too. `written` is false when no model wrote one (the title stays); 400 when the session has no messages yet. |
| `POST /api/sessions/:id/archive` | `{ archived }` | `{ archived }`. Hides the session from the lists, or brings it back. Nothing else changes; a run goes on. |
| `POST /api/sessions/:id/agent` | `{ model?, thinking? }` | `{}`. Applies from the next request. `model` is a pinned model's ID or `provider/id` for any model, here and when starting a session. |
| `POST /api/sessions/:id/withdraw` | `{ submission }` | `{ result }`: `aborted`, `already_placed`, `settled` or `not_found`. |
| `GET /api/sessions/:id/changes` | | `Changes`: totals and files, or `{ available: false, reason }`. |
| `GET /api/sessions/:id/changes/diff?path=FILE` | | `{ path, patch }`, for a file in the changes only. |
| `GET /api/sessions/:id/checkpoints` | | `{ checkpoints }`: each `{ id, at, tree, kind, message?, restored? }`. `kind` is `turn`, taken as the user message sent at `message` (a transcript item's `at`) started a turn, or `restore`, the files just before a restore of checkpoint `restored`. |
| `GET /api/sessions/:id/checkpoints/:n/changes` | | `Changes` from checkpoint `n` to the next, or to now for the latest. |
| `GET /api/sessions/:id/checkpoints/:n/changes/diff?path=FILE` | | `{ path, patch }`, for a file in those changes only. |
| `POST /api/sessions/:id/checkpoints/:n/restore` | `{}` | `{ written, deleted, files, undo }`: the project's files put back to checkpoint `n`. `undo` is the checkpoint taken just before, which restores what was there. 409 while the session runs or waits, or when it has no checkpoints. |
| `GET /api/search?q=WORDS&session=ID&limit=N` | | `{ results }`: `SearchResult`s, best first, for the messages and answers that have every word (the last one as a prefix; `test` matches `tests`). `session` limits it to one session, `limit` is 1 to 200 (default 50). Archived sessions are searched, marked `archived`. Tool calls and their output aren't. Each result has the session's title and project, and `item`, the transcript item's id, to open the session at it. |
| `GET /api/sessions/:id/images/:entry/:message/:block` | | The image's bytes, cached for good. |
| `POST /api/approvals/:id` | `{ allow }` | `{ status }`: `approved`, `denied` or `expired`. |
| `POST /api/ideas` | `{ project, text }` | `{ id }` |
| `POST /api/ideas/:id/start` | `{}` | `{ id }` of the new session. |
| `POST /api/ideas/:id/delete` | `{}` | `{}` |
| `POST /api/projects/color` | `{ project, color }` | `{ colors }`. `color` is a hue index 0 to 10, or `null` for the hashed one. |
| `GET /api/settings` | | `Settings`: every setting, described for a form (see "Settings" below). |
| `POST /api/settings` | `{ changes: { key: value \| null } }` | `Settings` after the change. `null` puts a setting back to its default. A refused change is 400 with one reason per line, and nothing is saved. |
| `GET /api/push` | | `PushState`: the public key devices sign up with, and the devices. |
| `POST /api/push/subscribe` | `{ endpoint, keys: { p256dh, auth }, label? }` | `PushState` |
| `POST /api/push/unsubscribe` | `{ endpoint }` | `PushState` |
| `POST /api/push/test` | `{}` | `{ devices, inSeconds }`. Sends a test notification after 5 seconds. |

`images` is a list of `{ mimeType, data }`, with `data` base64: PNG, JPEG, GIF or WebP, at most 8, each at most 5 MB, and the bytes must match the type. Scale images to 1568 px on the long side before sending; the model sees no more than that.

`files` is a list of `{ name, mimeType?, data }`, with `data` base64: any kind of file, at most 20, together at most 25 MB. The host saves each in the data directory's `uploads/<session>/` for 14 days and the message carries a `<file name type bytes path until>` text block for each, which the agent reads with its tools. A message's text over 32 KB is saved the same way, as `message.txt`: the message keeps its first 1,500 characters or so and a note saying where the rest is. That applies to every way in, the CLI included.

`requestId` makes a send safe to retry: the same ID finds the message already sent rather than sending it twice.

Any other path is a 404.

### Settings

Each setting describes itself, so a client can draw a settings screen from the list without knowing aludra's settings. `Settings` is `{ file, settings, restart, errors }`:

- `file`: the settings file's path, or null when the host started without one (then nothing can be saved).
- `settings`: a `Setting` for each, in a sensible order for a form.
- `restart`: the keys whose saved value the running host doesn't have yet.
- `errors`: what's wrong in the file, such as a hand edit the host wouldn't start with.

A `Setting` is:

| Field | Meaning |
| --- | --- |
| `key` | Its place in the file, such as `approvals.hosts`. The key to change it by. |
| `label`, `help` | A name and one line of help, for the form. |
| `kind` | The value's shape: `text` or `path` (a string), `number`, `integer`, `list` (strings), `model` (`provider/id`; bootstrap's `catalog` lists them), `models` (a list of those), `choice` (one of `options`), or `workspaces` (a list of `{ name, roots }`). |
| `value` | What the host makes of the file: defaults filled in, `~` expanded in paths, and `ALUDRA_DATA_DIR` or `ALUDRA_MODEL` applied. |
| `default` | The value when the file doesn't name it; absent for `workspaces`. |
| `set` | Whether the file names it. |
| `options` | A `choice`'s values. |
| `editable` | Whether clients can change it. `api.users`, `api.port`, `claude.path` and `dataDir` aren't editable. |
| `live` | Whether a change reaches the running host without a restart. |

[configuration.md](configuration.md#changing-settings-while-the-host-runs) says when each change takes effect.

### The live socket: `WS /api/live`

Same identity and same-origin checks as HTTP. The server pings every 25 seconds.

On connect, the server sends `sessions`, `ideas` and `colors`, then keeps each current:

| Event | When |
| --- | --- |
| `{ type: "sessions", sessions: SessionSummary[] }` | Any session's state, title, latest line or age changed. Newest first. |
| `{ type: "ideas", ideas: Idea[] }` | An idea was added, started or deleted. |
| `{ type: "colors", colors }` | A project's color was picked or reset. |
| `{ type: "settings" }` | The settings were changed. The bootstrap's projects, models and defaults may have changed too; fetch it again. |
| `{ type: "items", session, start, items, length }` | The followed session's transcript, from `start` on. Items before `start` are unchanged; drop any after `length`. |
| `{ type: "meta", session, meta: SessionMeta }` | The followed session's state, model, thinking, context use, queued messages, pending approval and retry. |
| `{ type: "error", message }` | A client event couldn't be handled. |

The client sends:

| Event | Effect |
| --- | --- |
| `{ type: "follow", session }` | Follow one session's transcript (`null` for none). The server sends its whole transcript and meta, then changes. |
| `{ type: "visible", visible }` | Whether the client is on screen. A session followed on screen gets no notifications. |

Transcript items are `user`, `answer`, `call`, `failure` and `compacted` (see `Item` in `src/api-types.ts`). Long call arguments and outputs are cut to 6,000 characters: arguments keep their start, outputs their end.

## amyrlin's endpoint: `WS /amyrlin`

amyrlin's protocol v1, documented in amyrlin's `docs/protocol.md`. aludra takes the same `Tailscale-User-Login` check as the HTTP API, and refuses any upgrade with an `Origin` header, so browsers can't open it.

How aludra maps onto the protocol:

- `conversations.create` takes a project directory (or a `cwd` naming one) and the first message; without a project it makes a no-project session. The project can't change afterwards, so `configure` changes only the model and thinking.
- `conversations.list`, `conversations.rename`, `submit`, `abort`, `compact`, `reset`, `approval.answer`, `approval.forget`, `conversation.history`, `conversation.image`, `conversation.watch`, `host.info` and `host.watch` are supported.
- `submit` and `conversations.create` take `videos` beside `images`: a list of `{ name, mimeType, data, seconds?, frames? }`, MP4, QuickTime or WebM, at most 2 and 40 MB together, the bytes matching the type, with up to 6 `frames`, each an image as above plus `at`, its time in seconds. The host saves each video in the data directory's `uploads/<session>/` for 14 days and adds a `<video name path seconds until>` text block to the message, followed by its frames as image blocks. A retried request saves nothing again. `host.info` carries `videos: { maxVideos, maxBytes, maxFrames, keepDays }`, which tells a client the host takes them. The HTTP API doesn't take videos.
- `submit` and `conversations.create` take `files` too, `[{ name, mimeType?, data }]`, as the HTTP API does; a file alone names a new session. `host.info` carries `files: { maxFiles, maxBytes, pasteBytes, keepDays, maxMessageBytes }`: the limits, the text length past which a message goes to a file, and the most a message's images, videos and files may come to together (80 MB, to fit the socket's frame as base64). A host without `files` drops them without a word, so a client should send none to it.
- `projects.archive { project, archived? }` hides a project from the lists, or brings it back with `archived: false` (default `true`, idempotent). `project` is its directory, or its name or `parent/name` when that's unique. Its files and sessions don't change. It answers `{ project, archived }`, the project as `host.info` lists it, and every `host.watch` gets `host.projects`. Each of `host.info`'s and `host.projects`' projects carries `archived: true` while it's archived; a client leaves those out of its project list and may show them in a folded group. An unknown project is `bad_request`. Archived projects are kept by directory, so one whose folder the roots no longer match can still be brought back by its directory.
- `host.info` carries `skills: [{ name, description }]`, the user's skills (the agent directory's `skills/`), and each of its `projects` carries `skills` in the same shape, that project's own (`.pi/skills` in its directory), empty when it has none. They're the skills a new session in that project is told about, in the prompt's order: a project skill named like a user skill is left out, since the user's wins. Skills marked `disable-model-invocation` aren't listed. `host.projects` carries the projects' skills too, reread with the checkouts. A sandbox gets copies of both kinds when it's made, and its summary's `sandbox.skills` lists the names it got: `[]` when the copy failed, in which case its prompt names no skills, and absent for a sandbox made before the copies, whose prompt names none either. A client's picker inserts `/skill:<name>` at the start of a message. When a submitted message starts that way, the host replaces the command with the skill's file in a `<skill name location>` block, with the rest of the line after it, in local and sandbox sessions alike. An unknown name is sent as it was typed. A host from before this leaves `skills` out.
- `projects.setColor` picks a project's color; `host.info` and the host snapshot carry the picked colors, and `host.projectColors` announces changes.
- Summaries carry `cost`, the dollars billed providers (OpenRouter) charged for the session, only when it used one. `spend` stays as the protocol defines it, Pi Durable's usage priced at API rates for every model, plan-paid ones (Claude Code, ChatGPT) included, so a client showing money should show `cost`. `host.info` and `host.snapshot` carry `monthCost`, this calendar month's charged total, when any session was charged.
- `settings.get` and `settings.set { changes }` are aludra's own additions to the protocol, each answering `{ settings }` with the same `Settings` as the web API. A refused change is `invalid_settings` with `data.errors`, one reason each. A host from before them answers `unknown_method`, which is how a client can tell whether to offer settings.
- `conversations.retitle {conversationId}` is aludra's own: a model writes the title again from the whole conversation, replacing any title, one set by hand too. It returns `{conversation, written}`, and watchers get `conversation.updated` when it's written; `written: false` means no model did, and the title stays. A session with no messages is `bad_request`. A host without it answers `unknown_method`.
- `conversation.page {conversationId, page}` is aludra's own: `{page, title, html, bytes, createdAt, csp}`, a page the agent published with its `publish_page` tool. A page is a tool result item with `toolName: "publish_page"` whose `details` are `{page, title, bytes}`; show it where that call is. `html` is a whole document, already sealed: its images are inlined and its `<head>` starts with a Content-Security-Policy (`csp`, also given separately for a web view that sets its own) that lets it run inline scripts and styles and reach nothing on the network. Show it in a web view with no bridge back to the app, loaded from the string, and open links in the browser. A missing page is `not_found`. `host.info` carries `pages: true` on a host that has them.
- `messages.search {query, conversationId?, limit?}` is aludra's own: `{results}`, the same `SearchResult`s as `GET /api/search`. A result's `entry` is the item's entry ID in `conversation.history`.
- `checkpoints.list {conversationId}`, `checkpoints.changes {conversationId, checkpoint, path?}` and `checkpoints.restore {conversationId, checkpoint}` are aludra's own, the same as the HTTP checkpoint endpoints: `{checkpoints}`, `{changes}` or with a path `{path, patch}`, and `{written, deleted, files, undo}`. A restore while the session runs or waits is `busy`. A checkpoint's `message` matches a user item's `at`, so a client can offer a restore beside the message whose turn it starts.
- `conversations.archive` hides a session from the lists, or brings it back with `archived: false`; running work goes on. `conversations.list` leaves archived sessions out unless `includeArchived` is set, and `host.watch` carries them marked `archived` for the client to filter. The host also archives sessions idle for `archive.afterDays` on its own, and those arrive the same way; one brought back with `archived: false` stays until it's archived again, so a client needs no rule of its own. `conversations.fork` answers `unsupported`.
- Pending approvals are `approval.requested`. Approved, denied, and expired, stopped or superseded requests are `approval.resolved` with `approve`, `deny` or `cancelled`.
- `approval.answer` with `always: true` (only with `approve`) lets the session run the request's summary, `git push` or `ssh to host`, without asking again, and approves its other requests for it. Summaries list those as `alwaysAllowed`, present only when there are any; `approval.forget {conversationId, summary}` takes one back and returns `{conversation}`.
- Spend comes from Pi Durable's usage. On a subscription its cost is 0; the token counts are real.

### Sandbox tasks

aludra's own, from amyrlin's protocol section 10 item 19. A host with a sandbox host in its settings (`sandboxes`) carries `sandboxes: { shipTo, afterRun, approvals }` in `host.info`; one without leaves it out and answers `conversations.create` with `sandbox: true` as `unsupported`.

- `conversations.create` takes `sandbox: true`, and with it `approvals: "ask" | "off"`, which overrides `sandboxes.approvals` for that session (`approvals` without `sandbox` is `bad_request`). It answers at once, and the sandbox is made after. The first message, and any `submit` before the sandbox is ready, is held in the database (so a restart doesn't lose it) and sent in order once the sandbox is ready. A held `submit` answers `{ submission: { requestId, type: "input", status: "queued" } }`, with no `id` until it's sent.
- A sandbox session's summary carries `sandbox: { number, branch, state, approvals, base?, step?, reason?, group?, size?, skills?, shipped?, shipStopped? }` and `source`, the project's directory on the host; `dir` is the project's directory in the sandbox. `number` names the branch, `sandbox/<number>` in the project's checkout. aludra gives these out itself, one count across projects, never reused, and past any `sandbox/<n>` branch already in the checkout; the sandbox host's own numbers are reused once a sandbox is deleted, so they can't name branches. Sessions from before keep `sandbox/<sandbox host's number>`.
- `state` is `preparing` (with `step`: `waiting` for a template another session is making, `cloning`, `installing`, `saving` or `starting`), `ready`, `paused` (the sandbox host paused it after a minute idle; read once a minute while a client watches), `failed` (with `reason`, the end of the error) or `removed` (deleted when the session was archived). `base` is the project's commit the sandbox was made from. `approvals` is what the session follows, its own or the host's (an addition to item 19, so the app can mark a task that asks). `conversation.updated` carries each change.
- While a message is held, the summary's `status` is `busy`. A sandbox that fails leaves the held message unsent and the session `status: "stuck"` with `stuck: { reason: "sandbox_failed", detail }`; later messages are `bad_request`. Start a new session to try again.
- `sandbox.sync { conversationId, merge? }` fetches the sandbox's commits into its branch now and returns `{ branch, head, commits, uncommitted, merged? }`: `commits` new on the branch, `uncommitted` files left in the sandbox (counted, not fetched), and with `merge`, `merged: true` or `{ reason }` for the fast-forward of the checked-out branch, under the same rules as `aludra sync --merge`.
- `conversations.create` with `sandbox` also takes `group`, a short string: sessions made with the same `group` are attempts at one ask (the app's ×3), and their summaries carry it as `sandbox.group`. `group` without `sandbox` is `bad_request`.
- `sandbox.ship { conversationId, to?, note? }` starts a ship and answers `{ started: true }`. `to` is `main` or `branch` and defaults to `sandboxes.shipTo`; `note` goes at the top of the ship prompt. The ship runs as a normal turn (watchers see it stream), and sending it is the approval of the push. A ship while the session runs, or while it already ships, is `busy`. When it ends, every `host.watch` gets `{ type: "sandbox.shipped", conversationId, shipped: true, to, pushed, head, commits, pr?, baseFailures?, unchecked? }`, where `to` is the mode and `pushed` the remote branch (`origin/main`), or `{ type: "sandbox.shipped", conversationId, shipped: false, kind, reason }`. Work with nothing beyond the upstream once rebased (it landed already, or changed nothing) lands with nothing pushed: `shipped: true, to: "main", commits: 0`, `pushed` the upstream branch and `head` its commit, and the ship prompt tells the session to say `SHIP-READY` for it. `kind` is `blocked` (the session didn't say `SHIP-READY`, or its run was stopped or failed), `upstream_moved` (the push was refused because the upstream moved; ship again), `push_failed` (git or gh couldn't reach the upstream) or `check_failed` (a check here before pushing: files left uncommitted, the branch not on the upstream, no upstream, or a project check that fails with the work and passes without it). A ship cut off by a restart is picked up again with the same prompt, which Pi Durable doesn't send twice. While it ships, `line` is `Shipping · <the step of its plan>` (the ship prompt asks for a plan block, as for any work), and each of the session's shell commands is stopped after 5 minutes.
- A ship's checks are run by the host, not the agent: the ship prompt tells the session it needn't run them, and it says `SHIP-READY` or `SHIP-BLOCKED` for its own reasons (a conflict, a decision only the user can make). Once it's ready and the result is fetched and on the upstream, and before anything is pushed, the host runs the project's declared checks (`.agents/project.json` at the rebased HEAD) in the sandbox, as after each answer: `bash -lc` in the project's directory, one after another, up to 15 minutes each. A project that declares none gets the test, build, type-check and lint commands of the work's last turn that wasn't a ship's (what `task.result` shows as its checks), only those that passed there, and none naming a path outside the project (an absolute path elsewhere, `~`, or `..` out of it). With neither, the ship goes on unchecked and its outcome carries `unchecked: true`. A check that fails is run again at the upstream's commit, in a git worktree beside the project with its `node_modules` linked in (installed afresh when the work changed the dependencies), so the agent's tree isn't touched. If it fails there too, it isn't the work's: the ship goes on and `baseFailures: [{ name, reason }]` lists each such check with the first line of its output. If it passes there, the ship stops as `check_failed` with `<name> fails: <first line>; it passes on main, so nothing was pushed`, and nothing is pushed. The agent gets no second round; ship again after asking it for a fix. Work with nothing beyond the upstream skips the checks, since nothing is pushed.
- The summary's `sandbox` keeps how its ships went: `shipped: { at, to, pushed, head, commits, pr?, baseFailures?, unchecked? }` once one lands, kept until another lands, and `shipStopped: { at, kind, reason }` for the latest that stopped short, cleared when the next starts or lands. `conversation.updated` carries both. Until the next message, `line` says it too, `Shipped to main · 2 commits`, `Shipped to main · 1 commit · types fails on main too: cargo: not found` (one base failure; with more, their names, `types, lint fail on main too`), `Already on main` (no commits) or `Ship stopped · <reason>`, and a ship's answer without a result block gets its `summary` from the outcome (`Shipped to main: 1 commit.`, with `Types fails on main too: …` after it, or `Ship stopped: …`) rather than its first paragraph. A ship to a branch for review says `on the base too` in place of the branch's name.
- `sandbox.discard { conversationId }` deletes the local `sandbox/<number>`, unmerged commits and all, and returns `{ branch, deleted }`; the sandbox stays. Archiving the session afterwards deletes the sandbox without fetching its commits again. A later `sandbox.sync` brings the branch back.
- Archiving a sandbox session deletes its sandbox, as the CLI's does (`cli.md`, Sandboxes).
- `group.keep { group, conversationId }` keeps that attempt and archives the group's others: each is stopped if it's running, its `sandbox/<number>` deleted, and archived, which deletes its sandbox without fetching. It returns `{ archived: [ids] }`.
- Notifications (Web Push, `/api/push`) for a sandbox session say what came back: `Done · project` with `1 commit on sandbox/4 · <summary>` once the run's commits are fetched, `Needs you · project` with the question when the answer asks one, and `Shipped · project` or `Ship stopped · project` when a ship ends. A ship's own turn sends no Done.
- Each of `host.info`'s `projects` carries `checkout: { branch?, dirty, ahead, behind, upstream?, sandboxes, checks, code }`: the checked-out branch (absent when detached), how many paths are uncommitted (untracked ones included), commits ahead of and behind its upstream as last fetched (aludra never fetches to work them out), and `sandboxes: true` or `{ reason }` when a sandbox can't start from it: no sandbox host, not in git, no commits yet, or inside a bigger repository. `checks` is how many checks the last commit's `.agents/project.json` declares (what a sandbox, made from that commit, would run), and `code` whether that commit has something to check: a package manifest, Makefile or the like in the project's folder. It's read with `git status --no-optional-locks`, so reading it doesn't touch the index. While a client watches the host, the checkouts are read every 5 s, and `host.watch` sends `{ type: "host.projects", projects }`, the whole list, when any changed. This is on every host, with or without a sandbox host.
- Every summary carries `line`, one short sentence of where the session stands, for the task list: `Making its sandbox · cloning` while it's made, the unchecked step of its plan while it runs (`Working` without one), `Waiting for your approval`, `Shipping`, `Asks: …` when its latest answer asks something, or the answer's first sentence with `· checks pass`, `· 2 checks fail` or `· running checks`. It's absent when there's nothing to say yet.
- `task.result { conversationId }` returns `{ result }` for the latest answer, or `{ result: null }` before one: `{ at, summary, changes, headsUp, checks, shots, code, plan?, question? }`. While a run goes on it returns `{ result: { at, plan } }` instead, `plan` being `[]` until the agent writes one. Every session's prompt, on this machine or in a sandbox, asks the agent to keep a fenced `plan` checklist (`- [ ]`, `- [x]`) as it works, and to end a reply that asks the user something with a fenced `result` block of JSON, `{ question: { text, why?, options } }`. aludra reads them from the transcript when asked, leniently. The prompt no longer asks for `summary`, `changes` or `headsUp`, but a block that has them (older answers did) is still read: `summary` is the block's, else the answer's first paragraph, and `changes` and `headsUp` are `[]` when the answer doesn't give them. `headsUp` kinds are `upstream`, `dependency`, `left` and `other` (anything else). `checks` are `[{ name, ok, detail? }]`: the project's declared checks, run in the sandbox once a run ends with an answer, or until they've run (or for a project with none), the turn's own bash calls that test, build, type-check or lint, the last run of each. `code` is `{ commits, files, add, del }` for `sandbox/<number>` in the project's checkout against `base`, zeros before the branch comes home. `shots` are `[{ id, label, side, path }]`, the result's screenshots (below), `[]` without any. A session outside a sandbox gets the same from its transcript, with zero `code`.
- A project declares its checks in `.agents/project.json` in its repository: `{ "checks": ["pnpm test", { "name": "types", "command": "pnpm exec tsc --noEmit" }] }`, at most 10, each run with `bash -lc` in the project's directory in the sandbox, one after another, for at most 15 minutes each. They run once per answer, not during the ship's turn, and `conversation.updated` carries the `line` as they start and end. A ship runs them again itself at the rebased HEAD before pushing (above). A `detail` is the end of a failing check's output.
- `task.code { conversationId, path? }` returns `{ changes }` in the shape of `checkpoints.changes` for `sandbox/<number>` against `base`, or with `path` `{ path, patch }`, `not_found` for a file it doesn't change. `{ changes: { available: false, reason } }` before the branch comes home. For a session outside a sandbox it's the session's changes since it started, as `GET /api/sessions/:id/changes` gives them (the commits it made and what's uncommitted, not what was uncommitted before it started), and with `path` that file's patch; a session without a recorded start, such as one in a project that isn't in git or in no project, gets `{ changes: { available: false, reason } }`, and `not_found` for any `path`.
- Screenshots are opt-in per project: it declares `devServer: { command, port }` and `pages` (paths, or `{ path, label? }`; `/` by default) in `.agents/project.json` and installs Playwright's Chromium in its `.agents/setup` ([configuration.md](configuration.md#sandboxes)). After the declared checks, through the same step after each run that ends with an answer, aludra shoots each declared page, then the pages the work's changed routes make (file-based routers; dynamic routes left out), at most 6, at 1280×800. `after` is at the sandbox's HEAD, `before` at `base`, each in a git worktree of its own beside the project in the sandbox, with the project's `node_modules` linked in (installed afresh for `before` when the work changed the dependencies), so the agent's files are never touched. The dev server is started with `PORT` set, given 2 minutes to answer on its port, and stopped with its process group afterwards; anything the agent left listening on that port is stopped first. `label` is the declared label or the path; `path` is the page's path. A page that doesn't load, or answers 400 or more, is left out on that side, so a new page has only an `after`. Without a dev server, or without Playwright and its Chromium in the sandbox, `shots` is `[]` and nothing says why (the host logs it). Shots are taken once per answer, never during a ship (a ship waits for them), and `line` ends `· taking screenshots` meanwhile. They're kept in the data directory's `shots/<session>/` for 14 days, as uploads are.
- `task.shot { conversationId, shot }` returns `{ mimeType: "image/png", data }`, `data` base64, for a shot `id` from the result; `not_found` for an unknown one or one past its days.
- These answer `bad_request` for a session that isn't in a sandbox, has no project, or whose sandbox isn't ready or was deleted; `task.result` and `task.code` take any session.

### New projects and scratch sandboxes

aludra's own, from amyrlin's protocol section 10 item 20.

- `host.info` carries `newProjects: { root, owner }` when the settings name them ([configuration.md](configuration.md#newprojects)) and `gh` is signed in to github.com; otherwise it's absent. gh's sign-in is read at most once a minute.
- `projects.create { name, description? }` makes `<root>/<name>`: `git init` on `main`, a `README.md` with the name and description, a first commit, then a private `<owner>/<name>` on GitHub with `main` pushed, so `origin/main` is its upstream. It returns `{ project }`, the project as `host.info` lists it, with its `checkout`, and every `host.watch` gets `host.projects`. `name` is lowercase letters, digits and `-`, starting with a letter or digit and not ending with `-`. It's `bad_request` for a bad name, an existing folder or repository (the message says which), or a host that can't make projects (the message says why), and `internal` when git or gh fails after it started. A failure removes the folder it made; a repository gh had created is left on GitHub, and the message says so. A project made this way can take a sandbox at once: its first commit is its template's.
- `conversations.create` with `sandbox: true` and no `project` is a scratch sandbox. aludra makes a repository for it in the data directory (`scratch/<id>/`) whose `main` is one empty commit, the same commit for all of them, so they share one template; the sandbox is a clone of it at `/home/user/work/scratch`, and the agent is told it's scratch work: commit as it goes, nothing ships. Its summary has no `project`, and `sandbox` and `source` (that repository) as for any. `sandbox.sync`, `task.code`, results and checks work against the empty commit; `sandbox.ship` is `bad_request`, with no upstream.
- `sandbox.promote { conversationId, name, description? }` makes a scratch sandbox's work a project: its commits are fetched, then `projects.create` makes `name` with them as `main` in place of a first commit, and pushes. The answer is `projects.create`'s. The session then belongs to the project: its summary's `project` and `source` are the project's, `sandbox.base` is the new `main`, and `sandbox/<number>` in the project is at it, so the next run's work comes home there and Ship lands on its `origin/main`. It's `bad_request` for a session that isn't a scratch sandbox, is running, has no sandbox, or has uncommitted files in it (ask the agent to commit first), and for the reasons `projects.create` refuses.
- `conversations.create` with `sandbox` takes `size`: `small` (2 CPUs, 4 GB), `medium` (4, 8 GB) or `large` (8, 16 GB) or `xlarge` (8, 32 GB). Without it the session takes the project's `size` from `.agents/project.json` at the commit its template is made from, else `small`. The template is made at `large` whatever the size. The summary's `sandbox` carries `size` once the sandbox is being made. `size` without `sandbox`, or another value, is `bad_request`.
- A project's `.agents/resume`, if it's executable, runs in the sandbox each time a paused sandbox wakes for a tool call, before that call: as `user`, from the project's directory, for at most 60 s. A failure or a timeout is logged in the host's log and the call goes on.

`test/amyrlin.test.ts` checks the translation against amyrlin's recorded scenarios (`test/fixtures/amyrlin/`).

## MCP: `POST /mcp`

Streamable HTTP, for agents aludra didn't start (Claude Code, pi, anything with an MCP client) to work with its sessions. It's stateless: each request stands alone, with JSON responses rather than streams. It takes a bearer token, `Authorization: Bearer <TOKEN>`, made with `aludra token add NAME` (one per agent; see [cli.md](cli.md#aludra-token-add-name---write)), not the API's `Tailscale-User-Login`, which a tagged machine doesn't have. A missing, wrong or revoked token is 401 with `WWW-Authenticate: Bearer`. A request with an `Origin` header is 403, as on `/amyrlin`, so a browser page can't call it. Only POST; other methods are 405.

Tools, always:

| Tool | Arguments | Answer |
| --- | --- | --- |
| `list_projects` | | Each project's name, workspace and directory. |
| `list_sessions` | `project?`, `includeArchived?`, `limit?` (default 30) | Sessions newest first: id, project, title, state, latest activity, when. |
| `read_session` | `id` | The session's title, project and state, then its transcript as text: messages, answers and a line per tool call, the latest 60,000 characters. |
| `search_messages` | `query`, `session?`, `limit?` (default 20) | As `GET /api/search`. |
| `check_sessions` | | `{ wake, data, topic, through? }`, a gate for an agent that wakes on session changes without a model running. Moves nothing. |
| `mark_sessions_handled` | `through` | `{ through }`: this token's changes up to and including change `through` are handled. |

`check_sessions` and `mark_sessions_handled` work as a mail connector's `check_new_mail` and `mark_handled(throughUid)`. A change is a session that's new, or that has come to rest in `done`, `failed`, `stopped`, `waiting` or `idle` since it was last seen: a new state, or the same state after a newer run (`done → done`). A session that's only started running isn't one, so the next change reads `running → done`. `wake` is true when the calling token has changes it hasn't marked handled. `data` has one entry per changed session, oldest change first: `change` (the newest change's number), `id`, `project`, `title`, `from` (`null` for a new session), `to`, `transition` (`"new → done"`, `"running → stopped"`), `state` now, `updated`, `line` (as `list_sessions`), `agent` (the last line of the latest answer's prose, without its `plan` and `result` blocks), `question: { text, options }` when that answer asks one, and `sandbox` and `archived` when they apply. `topic` is the newest change in a line, `site #12 Fix the build: running → done (+2 more)`, empty when there's nothing. `through` is the newest change's number, the value to mark once all of them are handled.

Each token has its own cursor, so one agent marking changes leaves them for another. A token that has never marked anything gets the changes to sessions updated since it was made. A cursor never moves back, and `through` past the newest change stops at it. Sessions are compared when an agent checks, not as they change, so a run that starts and ends between two checks is one change. What was last seen is kept in `session-changes.sqlite`, so changes made while nobody checked, or while the host was down, show at the next check. Sessions last updated before that file was made don't count as new. Both tools are there for read tokens: marking moves only the caller's own cursor.

For a token made with `--write`, while `mcp.write` is on in the settings file, also:

| Tool | Arguments | Answer |
| --- | --- | --- |
| `start_session` | `project`, `task`, `sandbox?`, `model?`, `effort?` | `{ id, project, dir, sandbox? }`. The task is the first message; its first line is the title until a model writes one. With `sandbox`, its tools run in a sandbox of its own, `dir` is in the sandbox, and `sandbox` is its number. |
| `send_message` | `id`, `text`, `mode?` (`followUp` or `steer`), `model?`, `effort?` | `{ submission }`. |
| `stop_session` | `id` | Stops the run. |

`model` is a pinned model's ID or `provider/id` for any model the host has, as the API takes; `effort` is a thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) that the model takes. Either is checked before anything happens, and an unknown model or a level the model doesn't take is an error that lists the ones it does. They're the session's settings from that turn on, as `POST /api/sessions/:id/agent` sets them, so a later message without them keeps them. Left out, a new session gets the host's defaults and a message changes nothing. `send_message` with either is an error while the session runs, since the running turn would pick them up partway; send them once it's idle.

With `mcp.sandboxOnly` on as well:

- `start_session` always makes a sandbox session, with or without `sandbox: true`. `sandbox: false` is an error and starts nothing.
- `send_message` and `stop_session` are an error for a session that isn't in a sandbox, whoever started it.
- Without a sandbox host in the settings, all three are an error for every call.
- The tools' descriptions and the server's instructions say sandbox-only. They're fixed per setting, so they don't change from one connection to the next.

No MCP tool syncs, merges, ships or archives. A sandbox session's work comes home as `sandboxes.afterRun` says.

A missing session or project is a tool result with `isError`, not a protocol error, and so is calling a write tool with a read token or while `mcp.write` is off, or an unknown model or effort. The server's instructions say which machine it is and, when it can't write, why.

## The CLI socket

`aludra.sock` in the data directory, owner-only. One JSON object per line, one request per connection.

Client to server, one of:

```json
{ "type": "ask", "content": "...", "project": "site", "requestId": "...", "steer": false }
{ "type": "ask", "content": "...", "session": 12 }
{ "type": "watch" }
{ "type": "watch", "session": 12 }
{ "type": "sessions" }
{ "type": "stop", "session": 12 }
{ "type": "approvals" }
{ "type": "decide", "id": "3f9a1c", "allow": true }
```

`{ "type": "archive", "session": 12, "archived": true }` archives a session, or brings it back with `false`.

`{ "type": "search", "query": "login test" }` sends matching messages as lines, two per result; `"session": 12` limits it to one session and `"reindex": true` builds the index again first.

`{ "type": "checkpoints", "session": 12 }` lists a session's checkpoints as lines; with `"restore": 3` it restores that checkpoint first and prints what changed.

`{ "type": "settings" }` answers with one `{ "type": "settings", "settings": Settings }`. With `"changes": { key: value | null }` it makes them first, as `POST /api/settings` does; a refused change is a `! ` line with the reasons and a `failed` status.

`{ "type": "retitle" }` writes titles for sessions that still have their first message's first line and sends a line for each. With `"session": 12` it writes that session's title again from its whole conversation, as `POST /api/sessions/:id/retitle` does, and the status is `failed` when no model wrote one.

`{ "type": "sessions", "listing": true }` asks for the sessions as data: the server answers with one `{ "type": "sessions", "sessions": SessionSummary[], "colors": { name: hue } }`, which the CLI lays out for its terminal, and `spend: { month }`, this calendar month's OpenRouter spend, when any session used OpenRouter. A summary's `cost` is that session's total. A sandbox session's summary has `sandbox`, its sandbox's number, and `source`, the project's directory on the host; its `dir` is then in the sandbox. Without `listing`, the server sends them as text lines. A host from before `listing` ignores it and sends lines, which the CLI prints as they are.

Server to client: any number of `{ "type": "line", "text": "..." }`, then `{ "type": "done", "status": "..." }` and the connection closes. `status` is `done` on success. A `watch` never sends `done`; it ends when the client closes.
