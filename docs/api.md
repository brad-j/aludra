# API

The host has three ways in: the HTTP and WebSocket API, amyrlin's protocol at `/amyrlin`, and the CLI's Unix socket. All three reach the same sessions. There's no web app. The types below are in `src/api-types.ts`, which a client in TypeScript can import.

## The HTTP API

Served on `127.0.0.1:<api.port>`, and reached through `tailscale serve`.

### Requests

Every request needs a `Tailscale-User-Login` header naming a login in `api.users`; otherwise 403. POSTs must send `Content-Type: application/json`, and an `Origin`, if present, must be this host. Bodies are JSON; message bodies may be up to 64 MB (for images), everything else up to 200 KB.

Errors come back as `text/plain` with a status: 400 for a malformed body or a bad value, 403 for identity or origin, 404 for a missing session, project, idea or model, 409 for an approval that isn't waiting, 413 for a body too large, 500 for anything else (also logged by the host).

### Endpoints

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/bootstrap` | | `Bootstrap`: the login, machine name, projects, the pinned models, every model the signed-in providers have (`catalog`, with prices where billed), thinking levels and defaults. |
| `POST /api/sessions` | `{ project, text, images?, model?, thinking?, requestId? }` | `{ id }`. An empty `project` makes a no-project session. Needs text or images. |
| `POST /api/sessions/:id/messages` | `{ text, images?, mode: "steer" \| "followUp", requestId? }` | `{ submission }`, for withdrawing it. |
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
- `projects.setColor` picks a project's color; `host.info` and the host snapshot carry the picked colors, and `host.projectColors` announces changes.
- Summaries carry `cost`, the dollars billed providers (OpenRouter) charged for the session, only when it used one. `spend` stays as the protocol defines it, Pi Durable's usage priced at API rates for every model, plan-paid ones (Claude Code, ChatGPT) included, so a client showing money should show `cost`. `host.info` and `host.snapshot` carry `monthCost`, this calendar month's charged total, when any session was charged.
- `settings.get` and `settings.set { changes }` are aludra's own additions to the protocol, each answering `{ settings }` with the same `Settings` as the web API. A refused change is `invalid_settings` with `data.errors`, one reason each. A host from before them answers `unknown_method`, which is how a client can tell whether to offer settings.
- `conversations.retitle {conversationId}` is aludra's own: a model writes the title again from the whole conversation, replacing any title, one set by hand too. It returns `{conversation, written}`, and watchers get `conversation.updated` when it's written; `written: false` means no model did, and the title stays. A session with no messages is `bad_request`. A host without it answers `unknown_method`.
- `checkpoints.list {conversationId}`, `checkpoints.changes {conversationId, checkpoint, path?}` and `checkpoints.restore {conversationId, checkpoint}` are aludra's own, the same as the HTTP checkpoint endpoints: `{checkpoints}`, `{changes}` or with a path `{path, patch}`, and `{written, deleted, files, undo}`. A restore while the session runs or waits is `busy`. A checkpoint's `message` matches a user item's `at`, so a client can offer a restore beside the message whose turn it starts.
- `conversations.archive` hides a session from the lists, or brings it back with `archived: false`; running work goes on. `conversations.list` leaves archived sessions out unless `includeArchived` is set, and `host.watch` carries them marked `archived` for the client to filter. `conversations.fork` answers `unsupported`.
- Pending approvals are `approval.requested`. Approved, denied, and expired, stopped or superseded requests are `approval.resolved` with `approve`, `deny` or `cancelled`.
- `approval.answer` with `always: true` (only with `approve`) lets the session run the request's summary, `git push` or `ssh to host`, without asking again, and approves its other requests for it. Summaries list those as `alwaysAllowed`, present only when there are any; `approval.forget {conversationId, summary}` takes one back and returns `{conversation}`.
- Spend comes from Pi Durable's usage. On a subscription its cost is 0; the token counts are real.

`test/amyrlin.test.ts` checks the translation against amyrlin's recorded scenarios (`test/fixtures/amyrlin/`).

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

`{ "type": "checkpoints", "session": 12 }` lists a session's checkpoints as lines; with `"restore": 3` it restores that checkpoint first and prints what changed.

`{ "type": "settings" }` answers with one `{ "type": "settings", "settings": Settings }`. With `"changes": { key: value | null }` it makes them first, as `POST /api/settings` does; a refused change is a `! ` line with the reasons and a `failed` status.

`{ "type": "retitle" }` writes titles for sessions that still have their first message's first line and sends a line for each. With `"session": 12` it writes that session's title again from its whole conversation, as `POST /api/sessions/:id/retitle` does, and the status is `failed` when no model wrote one.

`{ "type": "sessions", "listing": true }` asks for the sessions as data: the server answers with one `{ "type": "sessions", "sessions": SessionSummary[], "colors": { name: hue } }`, which the CLI lays out for its terminal, and `spend: { month }`, this calendar month's OpenRouter spend, when any session used OpenRouter. A summary's `cost` is that session's total. Without `listing`, the server sends them as text lines. A host from before `listing` ignores it and sends lines, which the CLI prints as they are.

Server to client: any number of `{ "type": "line", "text": "..." }`, then `{ "type": "done", "status": "..." }` and the connection closes. `status` is `done` on success. A `watch` never sends `done`; it ends when the client closes.
