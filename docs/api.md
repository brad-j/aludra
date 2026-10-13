# API

The host has three ways in: the web app's HTTP and WebSocket API, the Mac app's protocol at `/amyrlin`, and the CLI's Unix socket. All three reach the same sessions. The types below are in `src/api-types.ts`, which the app imports.

## The web API

Served on `127.0.0.1:<api.port>` beside the built app, and reached through `tailscale serve`.

### Requests

Every request needs a `Tailscale-User-Login` header naming a login in `api.users`; otherwise 403. POSTs must send `Content-Type: application/json`, and an `Origin`, if present, must be this host. Bodies are JSON; message bodies may be up to 64 MB (for images), everything else up to 200 KB.

Errors come back as `text/plain` with a status: 400 for a malformed body or a bad value, 403 for identity or origin, 404 for a missing session, project, idea or model, 409 for an approval that isn't waiting, 413 for a body too large, 500 for anything else (also logged by the host).

### Endpoints

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/bootstrap` | | `Bootstrap`: the login, machine name, projects, model choices, thinking levels and defaults. |
| `POST /api/sessions` | `{ project, text, images?, model?, thinking?, requestId? }` | `{ id }`. An empty `project` makes a no-project session. Needs text or images. |
| `POST /api/sessions/:id/messages` | `{ text, images?, mode: "steer" \| "followUp", requestId? }` | `{ submission }`, for withdrawing it. |
| `POST /api/sessions/:id/stop` | `{}` | `{}` |
| `POST /api/sessions/:id/title` | `{ title }` | `{ title }`, whitespace folded, 1 to 200 characters. |
| `POST /api/sessions/:id/agent` | `{ model?, thinking? }` | `{}`. Applies from the next request. |
| `POST /api/sessions/:id/withdraw` | `{ submission }` | `{ result }`: `aborted`, `already_placed`, `settled` or `not_found`. |
| `GET /api/sessions/:id/changes` | | `Changes`: totals and files, or `{ available: false, reason }`. |
| `GET /api/sessions/:id/changes/diff?path=FILE` | | `{ path, patch }`, for a file in the changes only. |
| `GET /api/sessions/:id/images/:entry/:message/:block` | | The image's bytes, cached for good. |
| `POST /api/approvals/:id` | `{ allow }` | `{ status }`: `approved`, `denied` or `expired`. |
| `POST /api/ideas` | `{ project, text }` | `{ id }` |
| `POST /api/ideas/:id/start` | `{}` | `{ id }` of the new session. |
| `POST /api/ideas/:id/delete` | `{}` | `{}` |
| `POST /api/projects/color` | `{ project, color }` | `{ colors }`. `color` is a hue index 0 to 10, or `null` for the hashed one. |
| `GET /api/push` | | `PushState`: the public key devices sign up with, and the devices. |
| `POST /api/push/subscribe` | `{ endpoint, keys: { p256dh, auth }, label? }` | `PushState` |
| `POST /api/push/unsubscribe` | `{ endpoint }` | `PushState` |
| `POST /api/push/test` | `{}` | `{ devices, inSeconds }`. Sends a test notification after 5 seconds. |

`images` is a list of `{ mimeType, data }`, with `data` base64: PNG, JPEG, GIF or WebP, at most 8, each at most 5 MB, and the bytes must match the type. The apps scale images to 1568 px on the long side before sending.

`requestId` makes a send safe to retry: the same ID finds the message already sent rather than sending it twice.

Any other `GET` outside `/api/` serves the built app: a file from `dist/client` if one matches, else the app's shell.

### The live socket: `WS /api/live`

Same identity and same-origin checks as HTTP. The server pings every 25 seconds.

On connect, the server sends `sessions`, `ideas` and `colors`, then keeps each current:

| Event | When |
| --- | --- |
| `{ type: "sessions", sessions: SessionSummary[] }` | Any session's state, title, latest line or age changed. Newest first. |
| `{ type: "ideas", ideas: Idea[] }` | An idea was added, started or deleted. |
| `{ type: "colors", colors }` | A project's colour was picked or reset. |
| `{ type: "items", session, start, items, length }` | The followed session's transcript, from `start` on. Items before `start` are unchanged; drop any after `length`. |
| `{ type: "meta", session, meta: SessionMeta }` | The followed session's state, model, thinking, context use, queued messages, pending approval and retry. |
| `{ type: "error", message }` | A client event couldn't be handled. |

The client sends:

| Event | Effect |
| --- | --- |
| `{ type: "follow", session }` | Follow one session's transcript (`null` for none). The server sends its whole transcript and meta, then changes. |
| `{ type: "visible", visible }` | Whether the app is on screen. A session followed on screen gets no notifications. |

Transcript items are `user`, `answer`, `call`, `failure` and `compacted` (see `Item` in `src/api-types.ts`). Long call arguments and outputs are cut to 6,000 characters: arguments keep their start, outputs their end.

## The Mac app's endpoint: `WS /amyrlin`

amyrlin's protocol v1, documented in amyrlin's `docs/protocol.md`. aludra takes the same `Tailscale-User-Login` check as the web API, and refuses any upgrade with an `Origin` header, so browsers can't open it.

How aludra maps onto the protocol:

- `conversations.create` takes a project directory (or a `cwd` naming one) and the first message; without a project it makes a no-project session. The project can't change afterwards, so `configure` changes only the model and thinking.
- `conversations.list`, `conversations.rename`, `submit`, `abort`, `compact`, `reset`, `approval.answer`, `conversation.history`, `conversation.image`, `conversation.watch`, `host.info` and `host.watch` are supported.
- `projects.setColor` picks a project's colour; `host.info` and the host snapshot carry the picked colours, and `host.projectColors` announces changes.
- `conversations.fork` and `conversations.archive` answer `unsupported`.
- Pending approvals are `approval.requested`. Approved, denied, and expired, stopped or superseded requests are `approval.resolved` with `approve`, `deny` or `cancelled`.
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

Server to client: any number of `{ "type": "line", "text": "..." }`, then `{ "type": "done", "status": "..." }` and the connection closes. `status` is `done` on success. A `watch` never sends `done`; it ends when the client closes.
