# aludra's app protocol, v1

Status: v1, reviewed 2026-10-12 (decisions in section 10). aludra serves it at `/app`; `/amyrlin`, its first path, answers too until loial and pi-desktop have moved.

The protocol was written for a native macOS client, since retired, and moved here from its repository on 2026-11-20. Where this document says "the Mac app", it means that client and describes what it did; loial's `docs/protocol.md` lists what loial uses.

This is the contract between a client and a server (one Node process per machine that owns a pi-durable 1.1.0 Harness, its SQLite store and its model credentials). The client depends only on this document. The server translates pi-durable's experimental `watchEvents()` stream into the events defined here.

Evidence for every durable shape is in `test/fixtures/durable-1.1.0/`. A reference like `02-tool-round:14` means line 14 of `test/fixtures/durable-1.1.0/02-tool-round.jsonl`. Shapes the fixtures could not show are marked **unrecorded**; they come from the 1.1.0 type definitions (`pi-durable/dist/harness/events.d.ts`) and the spec (§9.4).

## 1. Transport and identity

- One WebSocket per server: `wss://<machine>.<tailnet>.ts.net/app`.
- The server listens on `127.0.0.1` only. `tailscale serve` terminates TLS and proxies to it.
- `tailscale serve` adds `Tailscale-User-Login` and `Tailscale-User-Name` to tailnet requests and strips client-supplied copies. Values may be RFC 2047 "Q" encoded. Funnel traffic and traffic from tagged devices carry no identity headers.
- The server reads identity from the upgrade request. A request without `Tailscale-User-Login` is refused (HTTP 401 before upgrade). A login not on the server's allowlist is refused (HTTP 403). The client sends no tokens.
- The server keeps the identity for the connection and records it where it matters (approval answers).

## 2. Frames

Every WebSocket message is one UTF-8 JSON object with a `type`. Binary messages are not used.

| `type` | Direction | Purpose |
|---|---|---|
| `hello` | client → server | First frame. Offers protocol versions. |
| `welcome` | server → client | Accepts. Names the version and the host. |
| `goodbye` | server → client | Refuses or shuts down, then the server closes the socket. |
| `request` | client → server | A command. |
| `response` | server → client | The result or error of one request. |
| `event` | server → client | One batch of events for a subscription. |
| `end` | server → client | A subscription ended without being asked to. |

### 2.1 Requests and responses

```json
{"type":"request","id":"r42","method":"submit","params":{"conversationId":1,"requestId":"5e0c…","text":"Count to five."}}
{"type":"response","id":"r42","result":{"submission":{"id":8,"status":"placed","entryId":7},"duplicate":false}}
{"type":"response","id":"r43","error":{"code":"not_found","message":"No conversation 99","retryable":false}}
```

- `id` is a client-chosen string, unique per connection. Every request gets exactly one response with the same `id`.
- Responses may arrive in any order.
- A response has `result` or `error`, never both.

Error codes:

| Code | Meaning |
|---|---|
| `bad_request` | Params missing or malformed. |
| `unknown_method` | The method is not part of the negotiated version. |
| `not_found` | Unknown conversation, entry, approval or subscription. |
| `busy` | `submit` with `whenBusy: "reject"` on a busy conversation (durable `ConversationBusy`). |
| `already_resolved` | `approval.answer` for an approval that was already answered differently or cancelled. |
| `invalid_settings` | `configure` named an unknown model, thinking level or tool. |
| `unavailable` | The Harness is restarting (for example after a storage failure). `retryable: true`. |
| `unsupported` | The server doesn't offer this method, such as forks or archiving on a host without them. |
| `internal` | Anything else. |

### 2.2 Subscriptions

`conversation.watch` and `host.watch` return a subscription ID. Event frames for it follow:

```json
{"type":"event","subscription":"s3","seq":0,"events":[{"type":"snapshot", …}]}
{"type":"event","subscription":"s3","seq":1,"events":[{"type":"tool.updated", …}]}
```

- The server sends the `response` to the watch request before the subscription's first event frame.
- Frame `seq` starts at 0 and rises by 1 per frame within a subscription. The first frame holds exactly one `snapshot` event.
- One event frame of a `conversation.watch` carries the translation of one durable batch, which is one commit. The client applies a frame's events in order and renders after the whole frame. A durable batch whose events all translate to nothing produces no frame.
- A `snapshot` event can arrive later in any frame. It replaces all state the client holds for the subscription.
- `{"type":"end","subscription":"s3","reason":"…"}` ends a subscription. Reasons: `not_found`, `host_restarting`, `internal`. A client-initiated `unsubscribe` gets a response and no `end`.

### 2.3 Limits and keepalive

- `welcome.limits.maxFrameBytes` (default 16 MiB) bounds every frame. `URLSessionWebSocketTask.maximumMessageSize` defaults to 1 MiB, so the client must raise it to this value.
- A single item larger than the limit is sent with its text cut and `truncated: true`.
- The server sends WebSocket pings every 15 s. The client treats 45 s without any frame or pong as a dead connection.

## 3. Version negotiation

```json
{"type":"hello","protocols":[1],"client":{"name":"loial","version":"0.1.0"}}
{"type":"welcome","protocol":1,
 "host":{"hostId":"0f8e…","name":"egwene","serverVersion":"0.1.0","durableVersion":"1.1.0"},
 "you":{"login":"you@example.com","name":"You"},
 "limits":{"maxFrameBytes":16777216,"snapshotItems":200}}
{"type":"goodbye","reason":"unsupported_protocol","protocols":[2,3]}
```

- The client must send `hello` first and nothing else until `welcome`.
- `protocols` lists every version the client speaks. The server picks the highest one it also speaks. With none in common it sends `goodbye` and closes with code 4406.
- A version is a single integer. Within a version the server may add optional fields, but never new event types, methods or required fields. Those need a new version, and the server sends only what the negotiated version defines.
- The client ignores unknown fields. Enum values are open: an unknown status or reason decodes to an "unknown" case and is shown as such.
- An unknown event `type`, or an event that fails to decode, is a server bug under this rule. The client logs the raw frame, unsubscribes and watches again for a fresh snapshot. If one subscription fails this way three times in a minute, the client stops retrying it and shows the conversation as unreadable.
- `hostId` is a UUID the server creates once and keeps in its store. The client keys machines by `hostId`, not by DNS name.

Close codes: 4400 malformed or missing `hello`, 4406 no common version, 1001 server shutting down, 1011 internal error.

## 4. Data types

All IDs are JSON integers from pi-durable's numeric ID space. Entries, submissions, tasks and conversations share it. They are unique within one host and below 2^53, and the client stores them as `Int64` and pairs them with `hostId`. Tool call IDs are strings from the model. Times are integer milliseconds since the Unix epoch.

### 4.1 ModelRef, ThinkingLevel

```json
{"provider":"anthropic","modelId":"claude-sonnet-5-5"}
```

`modelId` is opaque to the client and may contain slashes: OpenRouter's are like `anthropic/claude-opus-5.5` and `~google/gemini-pro-latest`. Clients compare `provider` and `modelId` together and never split either.

`ThinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (pi-ai 1.1.0 `ModelThinkingLevel`).

### 4.2 Spend

```json
{"input":652,"output":746,"cacheRead":531,"cacheWrite":653,"total":2582,"cost":0.0,
 "byModel":{"faux/faux-1":{"input":652,"output":746,"cacheRead":531,"cacheWrite":653,"total":2582,"cost":0.0}},
 "byTool":{}}
```

The server builds `Spend` from durable `UsageState` (`09-manual-compaction:1` snapshot `usage`). Each pi-ai `Usage` becomes `{input, output, cacheRead, cacheWrite, total: totalTokens, cost: cost.total}`. The top-level counters are sums over `byModel` and `byTool`. `cost` is in US dollars. The faux provider always reports cost 0, so every fixture has `cost: 0`.

`byModel` is keyed `provider/modelId`, as pi-durable's `recordUsage` writes it. Provider IDs have no slash, so the provider runs to the first one and the rest is the model ID. pi-ai prices every answer at API rates, including answers on a flat plan (aludra's `claude-bridge` and `openai` on a ChatGPT sign-in), so `cost` is not money charged. Clients never show dollars from `Spend`; they show the charged `cost` and `monthCost` of section 10, item 10.

### 4.3 Items

A conversation's transcript is a list of items ordered by `id`. Each item comes from one durable entry. The table below is the complete mapping; the server applies it to snapshot entries, `message_end` entries, `entry_appended` entries and history pages.

| Durable entry | Wire item | Evidence |
|---|---|---|
| `kind: "pi.user"` | `type: "user"` | `01-plain-answer:2` |
| other kind whose first model message has role `user` (an input with a custom `entry`) | `type: "user"` plus `kind` and `data` | unrecorded |
| `kind: "pi.assistant"` | `type: "assistant"` | `01-plain-answer:13`, aborted `06-abort-mid-generation:8` |
| `kind: "pi.tool-result"` | `type: "toolResult"` | `02-tool-round:14`, error `07-abort-mid-tool:12`, blocked `08-blocked-tool:8` |
| `kind: "pi.reset"` | `type: "reset"` | `13-configure-and-reset:8` |
| `kind: "pi.compaction"` | `type: "compaction"` | `09-manual-compaction:4` |
| `kind: "pi.system"` | none: dropped | `01-plain-answer:4` |
| any other kind | `type: "custom"` | unrecorded |

Common fields: `id` (the entry ID), `type`, `at` (the first model message's `timestamp`, absent when the entry has no messages).

```jsonc
// user
{"id":7,"type":"user","at":1791840744377,"content":[{"type":"text","text":"Count to five."}]}
// assistant
{"id":11,"type":"assistant","at":…,"content":[Block…],"stopReason":"toolUse",
 "model":{"provider":"faux","modelId":"faux-1"},"spend":{…Spend without byModel/byTool…},"error":"…"}
// toolResult
{"id":13,"type":"toolResult","at":…,"callId":"call-1","toolName":"count",
 "content":[{"type":"text","text":"1\n2\n3\n4\n5\n"}],"isError":false,
 "details":{"counted":5},"diagnostics":[],"durationMs":507}
// reset
{"id":12,"type":"reset","at":…,"handoff":"We were planning a trip to Portugal.","contextStart":12}
// compaction
{"id":21,"type":"compaction","at":…,"summary":"The conversation history before this point was compacted…","reason":"manual","contextStart":19}
// custom
{"id":30,"type":"custom","kind":"app.note","data":{…}}
```

Field sources:

- `user.content`: the message's `content`. A string becomes one text block.
- `assistant.content`: the message's `content` as blocks (4.4). `stopReason` is `stop`, `toolUse`, `length`, `error` or `aborted`. `error` is `errorMessage` when present. `model` comes from `provider` and `model`, and `spend` from `usage`.
- `toolResult`: `callId` is `toolCallId`. `diagnostics` is the entry's `data.diagnostics`; the rest comes from the message. A blocked, aborted or interrupted call is an error result whose diagnostic `code` is `blocked`, `aborted` or `interrupted` (`08-blocked-tool:8`, `07-abort-mid-tool:12`, `11-crash-and-resume:18`).
- `reset.handoff`: the text of the reset's user message, absent without one. `contextStart` is the entry's `head`, which equals its own `id` (`13-configure-and-reset:8`).
- `compaction.summary`: the model message's text, unchanged. `reason` is `data.reason`. `contextStart` is `head`.

**Context start.** pi-durable's snapshot holds only the active transcript: the newest head marker, then entries from its `head` onward (spec §9.3). The app shows the whole history and greys out what the model no longer sees. The state carries `contextStart`, the lowest entry ID still in the model's context, or `null` before any reset or compaction. A `reset` or `compaction` item sets it when added. The compaction item itself sorts after the entries it keeps, because its ID is higher (`09-manual-compaction:4`: item 21 with `contextStart: 19`).

### 4.4 Blocks

```json
{"type":"text","text":"…"}
{"type":"thinking","text":"…","redacted":true}
{"type":"toolCall","id":"call-1","name":"count","args":{"n":5}}
{"type":"image","mimeType":"image/png"}
```

From pi-ai content: `thinking.thinking` becomes `text`. `thinkingSignature` is dropped. `toolCall.arguments` becomes `args`. Image `data` is not sent in v1.

### 4.5 ToolSlot

A tool call of the current round that the transcript cannot show yet.

```json
{"callId":"call-1","name":"count","status":"running","output":"1\n2\n3\n4\n5\n","droppedBytes":0,"droppedLines":0,"details":null,"diagnostics":[]}
```

`status` is `running` or `ended`. `ended` means the call finished without a result entry, after a fault or an orphaning (`tool_execution_end` without `entry`, `20-tool-fault:9`).

The server builds slots from durable `ToolSlot`s (`10-late-join:1`), with two rules that keep a late joiner's state equal to a from-the-start client's:

- Durable `pending` slots are omitted. A from-the-start client never hears about them, because `tool_execution_start` fires only when a call starts to run. The app infers pending calls from `toolCall` blocks that have no result item and no slot.
- Durable `done` slots that have an `entry` are omitted, because their result item carries everything.

Arguments are not in the slot. They are in the `toolCall` block of the assistant item with the same `callId`.

### 4.6 InboxItem

```json
{"submissionId":13,"mode":"steer","requestId":"5e0c…","text":"Stop at eight and say so."}
{"submissionId":40,"mode":"write","kind":"app.note"}
```

`mode` is `steer`, `followUp` or `write`. Durable's inbox events carry only `id` and `mode` (`04-steer-during-tools:9`). The server adds `text` (from the durable `InboxDoc` item's `content`), `kind` (for writes) and `requestId` (from the submission record, when it has one).

### 4.7 Submission

```json
{"id":8,"requestId":"req-02","type":"input","status":"done","entryId":7,"answerId":15}
{"id":8,"requestId":"req-06","type":"input","status":"unanswered","reason":"aborted"}
```

This mirrors the durable `SubmissionRecord` (`01-plain-answer:2`, `06-abort-mid-generation:8`), with `entry` and `answer` renamed to `entryId` and `answerId`. `status` is `queued`, `placed`, `done` or `unanswered`. `reason`, an open enum, is one of `aborted`, `stale`, `reset`, `no_model`, `model_error`, `faulted`, `missing_task` or `task_too_old`. `detail` passes through as JSON when present.

### 4.8 Settings

```json
{"stored":{"model":{"provider":"faux","modelId":"faux-1"},"thinkingLevel":"high","cwd":"/work/repo","tools":["read","bash"]},
 "effective":{"model":{"provider":"faux","modelId":"faux-1"},"thinkingLevel":"high","cwd":"/work/repo","tools":["read","bash"]}}
```

- `stored` is the durable `pi.agent` document (`AgentState`), limited to `model`, `thinkingLevel`, `cwd`, `tools` and `instructions`. An absent field follows the host default. `tools` is an array or `{"remove":[…]}`.
- `effective` is the server's `conversation.agent()` resolution: `model`, `thinkingLevel`, `cwd` and `tools` as the list of offered tool names.
- Registry and settings changes on the server emit nothing in pi-durable (spec §9.4), so `effective` can go stale until the next `settings.changed` or snapshot.

### 4.9 Approval

```json
{"approvalId":"1:call-1","conversationId":1,"callId":"call-1","toolName":"delete_file","args":{"path":"/tmp/notes.txt"},"requestedAt":1791840750000}
```

See section 8.

### 4.10 ConversationSummary

```json
{"id":1,"title":"Count to five.","status":"busy","archived":false,
 "parent":{"conversationId":1,"at":19},
 "model":{"provider":"faux","modelId":"faux-1"},
 "createdAt":1791840744000,"updatedAt":1791840745000,
 "pendingApprovals":0,"spend":{…Spend…},
 "stuck":{"reason":"missing_task","taskKind":"pi.tool"}}
```

- `status` is `idle`, `busy`, `needsApproval` or `stuck`, chosen in this order:
  - `needsApproval` when `pendingApprovals > 0`.
  - `stuck` when `harness.inspect()` shows a task of this conversation as `blocked`, for example a tool whose extension is not installed after a restart. `stuck` carries its reason.
  - `busy` while durable `pi.live.run` is present.
  - `idle` otherwise.
- `title` is the server's stored title, or the first line of the first user item cut to 80 characters, or `"New conversation"`.
- `parent` is the durable `ConversationRecord.parent`, present for forks.
- `model` is the effective model.
- `updatedAt` is the newest item's `at`, or `createdAt`.
- Title, `archived` and `createdAt` live in a server-owned conversation document (defined with `defineDoc`; aludra keeps them in its session records) and are written in the commit that creates the conversation. pi-durable has no titles or archiving.
- Conversations owned by a task, such as subagents, are not listed in v1. They can still be watched by ID.
- Servers that tie conversations to projects add `workspace`, `project` (its name) and `dir` (its directory). The snapshot's `conversation` carries `project` and `dir` too.

## 5. Commands

Each command lists its params, its result and how a retry behaves. The durable call it maps to is in brackets.

### `host.info`

Params: none. Result:

```json
{"host":{…as in welcome…},
 "models":[{"provider":"anthropic","modelId":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","reasoning":true,
            "thinkingLevels":["off","low","medium","high"],"contextWindow":200000,"maxTokens":64000,
            "input":["text","image"],"available":true}],
 "tools":[{"name":"bash","description":"…","requiresApproval":true}],
 "defaults":{"model":{…},"thinkingLevel":"medium"}}
```

[`models.getModels()` with `getAvailable()` for `available`, the registry snapshot's tools, and the server's approval policy.] A server whose conversations live in projects adds `"projects":[{"workspace":"egwene","name":"aludra","path":"Software/aludra","dir":"/home/you/Projects/Software/aludra"}]`; new conversations must name one. `thinkingLevels` lists the levels the model supports, from its `thinkingLevelMap`. Safe to retry.

### `conversations.list`

Params: `{"includeArchived":false}`. Result: `{"conversations":[ConversationSummary…]}`, newest `updatedAt` first. [`scanConversations` for ownerless conversations plus server state.] Safe to retry. `host.watch` carries the same data live; this is for one-off reads.

### `conversations.create`

Params: `{"requestId":"…","title":"…","settings":{"model":…,"thinkingLevel":…,"cwd":…,"tools":[…]},"project":"/dir","text":"…"}`. Everything except `requestId` is optional. On a server with projects, `project` (a `dir` from `host.info`, or `settings.cwd` naming one) picks one; without either, the server may make a no-project conversation in a scratch directory of its own (aludra does), whose summary has no `project`. `text` is submitted as the first message, with request ID `<requestId>:first`, and titles the conversation. Result: `{"conversation":ConversationSummary,"duplicate":false}`.

[`harness.createConversation({ownership:{kind:"ownerless"}, agent, init})`; `init` writes the conversation document with the title, `createdAt` and `requestId`.] pi-durable does not deduplicate creation. The server keeps a `requestId` → conversation index, rebuilt from those documents at startup, and returns the existing conversation with `duplicate: true` for a repeated `requestId`.

### `conversations.fork`

Params: `{"requestId":"…","conversationId":1,"at":19,"title":"…"}`. `at` is an item ID visible in the source conversation. Result: as `create`. [`conversation.fork(at, {ownership:{kind:"ownerless"}, init})`.] Deduplicated like `create`. Errors: `not_found` for an unknown conversation or an entry not visible in it.

### `conversations.archive`

Params: `{"conversationId":1,"archived":true}`. Result: `{"conversation":ConversationSummary}`. [Commit to the conversation document.] Archiving only hides the conversation from lists; running work continues. Idempotent.

### `submit`

Params:

```json
{"conversationId":1,"requestId":"5e0c…","text":"Use pnpm, not npm","whenBusy":"steer"}
```

`whenBusy` is `followUp` (default), `steer` or `reject`. It only matters while the conversation is busy; an idle conversation starts a run either way. Result: `{"submission":Submission,"duplicate":false}`.

[`conversation.submit({type:"input", content:text, requestId, whenBusy})`.] `requestId` is required. The client makes one UUID per user action and reuses it for every retry of that action. pi-durable returns the existing submission for a repeated `requestId`, also after a restart (`11-crash-and-resume:16`). The server reports that as `duplicate: true`, so a retry is exactly once. Errors: `busy` for `reject`, `not_found`.

The brief lists `steer` as its own command. This draft folds it into `submit` because pi-durable has one call with a `whenBusy` mode: Return sends `followUp`, and the steer modifier sends `steer`. A separate `steer` method would duplicate `submit`'s params, deduplication and errors. Section 10 asks whether to keep this.

### `abort`

Params: `{"conversationId":1}`. Result: `{}`, sent once the conversation is idle.

[`conversation.abort()`.] Queued inputs are withdrawn and settle `unanswered` with `aborted`; queued writes stay. Running generation and tools are aborted: the partial becomes an assistant item with `stopReason: "aborted"` (`06-abort-mid-generation:8`), and a running tool gets an error result with diagnostic `aborted` (`07-abort-mid-tool:12`). Pending approvals of the conversation resolve as `cancelled`. Idempotent. The app's Esc key sends it.

### `configure`

Params: `{"conversationId":1,"changes":{"model":{…}|null,"thinkingLevel":"high"|null,"cwd":"/work/repo"|null,"tools":["read","bash"]|null}}`. An absent field is unchanged and `null` resets the field to the host default. Result: `{"settings":Settings}`.

[`conversation.configure(change)`, with tool names resolved to registrations from the registry.] The change applies from the next model request; a running request keeps its model. Emits `settings.changed` (`13-configure-and-reset:6`, and `13-configure-and-reset:14` for a cleared field). Idempotent, because values are absolute. Errors: `invalid_settings` naming the unknown model, level or tool.

### `compact`

Params: `{"conversationId":1,"instructions":"Keep the failing test names"}`. Result: `{"taskId":20}`.

[`conversation.compact(instructions)`.] The summary is placed at once when idle, otherwise at the next turn boundary (`09-manual-compaction:2` to `:4`). Not deduplicated: a repeat starts a second compaction, and pi-durable settles the shorter cut as `stale`. The client does not retry it automatically.

### `reset`

Params: `{"conversationId":1,"handoff":"We were fixing the flaky login test."}`. `handoff` is optional. Result: `{}`.

[`conversation.reset(handoff)`.] Queued like a write while busy. It produces a `reset` item (`13-configure-and-reset:8`). `reset()` takes no `requestId`, so a repeat appends a second reset. The client does not retry it automatically.

### `approval.answer`

Params: `{"approvalId":"1:call-1","decision":"approve"|"deny","message":"Not that file"}`. Result: `{"approval":{…Approval…,"decision":"approve","by":"you@example.com"}}`.

[Resolves the server's waiting `beforeTool` hook; see section 8.] Repeating the same decision returns the same result. A different decision after resolution, or any answer after cancellation, returns `already_resolved` with the recorded outcome in `error.data`.

### `conversation.history`

Params: `{"conversationId":1,"before":120,"limit":100}`. Result: `{"items":[Item…],"hasEarlier":true}`, oldest first.

[`conversation.entries({maxEntryId: before - 1, order: "descending"}, limit)`, mapped by 4.3, `pi.system` dropped.] Entries are immutable, so this can run at any time without racing the watch. Safe to retry.

### `conversation.watch`, `host.watch`, `unsubscribe`

- `conversation.watch {"conversationId":1}` returns `{"subscription":"s3"}`.
- `host.watch {}` returns `{"subscription":"s1"}`.
- `unsubscribe {"subscription":"s3"}` returns `{}`.

See sections 6 and 7.

## 6. Subscriptions

### 6.1 `conversation.watch`

The first frame holds one `snapshot`:

```jsonc
{"type":"snapshot",
 "conversation":{"id":1,"title":"…","archived":false,"parent":null},
 "items":[Item…], "hasEarlier":false, "contextStart":null,
 "run":{"inputs":[8]},                          // null when idle
 "streaming":{"attempt":1,"content":[Block…],"model":{…}},   // null when no partial
 "retry":null,                                  // {"attempt":2,"at":…,"error":"…"}
 "tools":[ToolSlot…],
 "inbox":[InboxItem…],
 "approvals":[Approval…],
 "compactions":[{"taskId":20,"reason":"manual","blocking":false,"attempt":1,"retry":null}],
 "settings":Settings,
 "spend":Spend}
```

How the server builds it:

1. It calls `watchEvents(harness, id)`. `stream.snapshot` and the registration for later batches are taken atomically.
2. `items` are the durable snapshot's `entries` mapped by 4.3. If there are fewer than `limits.snapshotItems`, the server pages older entries with `entries({maxEntryId: lowestSnapshotEntryId - 1})`. It uses the lowest ID, not the first entry, because after a compaction the first entry is the summary and the entries it keeps have lower IDs (`09-manual-compaction:4`: summary 21, kept from 19). Older entries are immutable, so the read cannot race the stream. If the active transcript alone exceeds the limit, only its newest items are sent. `hasEarlier` says whether more exist.
3. `contextStart` is the `head` of the snapshot's first entry when that entry is a head marker, otherwise `null`.
4. `run` comes from `snapshot.run` (`10-late-join:1`). `streaming` comes from `snapshot.generation.message` (`10-late-join.mid-answer:1`). `retry` comes from `snapshot.generation.retry` (`17-retry.during-wait:1`).
5. `tools` follow 4.5, `inbox` follows 4.6, `settings` follow 4.8 and `spend` follows 4.2. `approvals` come from the server.

Later frames hold the events of section 7. When pi-durable delivers a fresh `snapshot` event because the consumer fell more than 100 batches behind (`14-overflow-snapshot:6`), the server builds a wire `snapshot` from it the same way.

### 6.2 `host.watch`

The first frame holds:

```json
{"type":"host.snapshot","host":{…as in welcome…},"spend":Spend,"conversations":[ConversationSummary…]}
```

Later events:

| Event | When |
|---|---|
| `{"type":"conversation.updated","conversation":ConversationSummary}` | A conversation was created, or any summary field changed. It carries the whole summary. |
| `{"type":"conversation.removed","conversationId":1}` | The conversation left the list. Reserved; v1 never deletes. |
| `{"type":"host.spend","spend":Spend}` | Session-wide spend changed (`harness.usage()`, which includes owned conversations). |

Archived conversations are included with `archived: true`; the client filters. The server derives statuses from each conversation's `pi.live` and `pi.usage` documents (`harness.watchDoc`), its own approval table, and `harness.inspect()` run at startup and after each registry change. It may coalesce updates for one conversation to at most 4 per second.

## 7. Conversation events

### 7.1 Catalogue and mapping

Each row lists the wire event, the durable event(s) it comes from, and fixture evidence.

| Wire event | Fields | From durable | Evidence |
|---|---|---|---|
| `snapshot` | 6.1 | `snapshot` (attach or overflow) | `10-late-join:1`, `14-overflow-snapshot:6` |
| `item.added` | `item` | `message_end`, `entry_appended`, except `pi.system` | user `02-tool-round:2`, assistant `02-tool-round:6`, result `02-tool-round:14`, reset `13-configure-and-reset:8`, compaction `09-manual-compaction:4` |
| `stream.started` | `attempt`, `content`, `model` | `message_start` with role `assistant` | `01-plain-answer:5` |
| `stream.delta` | `ops` | `message_update` (`usage` dropped) | `01-plain-answer:6` to `:12`, `03-parallel-tools:6` |
| `tool.started` | `callId`, `name`, `args` | `tool_execution_start` | `02-tool-round:7`, three at once `03-parallel-tools:8` to `:10` |
| `tool.updated` | `callId`, `output?`, `details?`, `diagnostics?` | `tool_execution_update` | set `02-tool-round:8`, append `02-tool-round:9`, details `02-tool-round:13` |
| `tool.ended` | `callId`, `resultId?` | `tool_execution_end` | `02-tool-round:14`, without a start `08-blocked-tool:8` |
| `run.started` | `inputs` | `run_start` | `01-plain-answer:2` |
| `run.ended` | `inputs` | `run_end` | `01-plain-answer:13`, steer joined `04-steer-during-tools:23` |
| `submission` | `submission` | `submission` | queued `04-steer-during-tools:9`, unanswered `06-abort-mid-generation:8` |
| `inbox.changed` | `items` | `inbox_update` (enriched, 4.6) | `04-steer-during-tools:9`, `04-steer-during-tools:20`, `05-follow-up-while-busy:7` |
| `settings.changed` | `settings` | `agent_changed` (plus resolution, 4.8) | `13-configure-and-reset:6`, `:14` |
| `spend.changed` | `spend` | `usage_changed` | `01-plain-answer:13` |
| `compaction.started` | `taskId`, `reason`, `blocking` | `compaction_start` | `09-manual-compaction:2` |
| `compaction.ended` | `taskId`, `reason` | `compaction_end` | `09-manual-compaction:4` |
| `retry.scheduled` | `attempt`, `at`, `error` | `auto_retry_start` (`errorMessage` → `error`) | `17-retry:5`, retries run out `18-retry-exhausted:5` to `:7` |
| `retry.cleared` | `attempt` | `auto_retry_end` | `17-retry:7` |
| `task.failed` | `taskId`, `kind`, `message` | `task_failed` | a tool task `20-tool-fault:9` |
| `approval.requested` | `approval` | server (section 8) | silence it fills: `12-approval-hook:6` to `:9` |
| `approval.resolved` | `approvalId`, `decision`, `by?`, `message?` | server (section 8) | none |

Durable events with no wire event:

| Durable | Why dropped |
|---|---|
| `turn_start`, `turn_end` | The app shows runs, not turns. Busy state comes from `run.*`. |
| `message_start` for user, tool result and system messages | Always followed by `message_end` in the same batch (`02-tool-round:2`, `:14`). `item.added` covers it. |
| `message_start`/`message_end` of `pi.system` | The app does not show system prompt changes. |
| `deferred_poll` | v1 does not use deferred responses. |
| `message_update.usage` | Spend updates arrive with `usage_changed` at the end of each response. |

### 7.2 Stream ops

`stream.delta.ops` translate `message_update.changes`. `index` is the durable `contentIndex`.

| Op | From change | Evidence |
|---|---|---|
| `{"op":"start","index":1,"block":Block}` | `text_start`, `thinking_start`, `toolcall_start` | text `01-plain-answer:8`, tool call `03-parallel-tools:6`; `thinking_start` unrecorded |
| `{"op":"appendText","index":0,"text":"…"}` | `text_delta`, `thinking_delta` | `01-plain-answer:9`, thinking `01-plain-answer:6` |
| `{"op":"appendArg","index":0,"path":["command"],"text":"…"}` | `toolcall_delta` | unrecorded |
| `{"op":"set","index":0,"block":Block}` | `block` | `03-parallel-tools:6` |
| `{"op":"replace","content":[Block…]}` | `message` | unrecorded |

`appendArg` appends `text` to the string at `path` inside the tool call's `args`, creating it as `""` when absent. During streaming, `args` can be a partial object (`03-parallel-tools:6` starts `call-b` with `{}`).

### 7.3 Reducer rules

Conversation state: `items` (keyed and ordered by `id`), `hasEarlier`, `contextStart`, `run`, `streaming`, `retry`, `tools` (keyed by `callId`), `inbox`, `approvals`, `compactions`, `settings`, `spend`, and `submissions` (keyed by `id`, for matching the client's `requestId`s).

| Event | Effect |
|---|---|
| `snapshot` | Replace all state. |
| `item.added` | Insert by `id`, replacing a duplicate. An assistant item clears `streaming`. A `reset` or `compaction` item sets `contextStart`. |
| `stream.started` | Set `streaming`. |
| `stream.delta` | Apply ops to `streaming.content` in order. Ignored when `streaming` is null. |
| `tool.started` | Add a `running` slot with empty output. |
| `tool.updated` | `output.set` replaces the output. Otherwise drop `trimStart` UTF-16 code units from the front, then add `append`. The unit is JavaScript's string length, which pi-durable uses; it is not Swift's `Character` count. Replace `details` and `diagnostics` when present; `null` and `[]` clear them. |
| `tool.ended` | With `resultId`, remove the slot. Without one, set the slot `ended` (creating it if absent). |
| `run.started` | Set `run`. |
| `run.ended` | Clear `run`, `streaming`, `retry` and every `ended` slot. |
| `submission` | Upsert by `id`. |
| `inbox.changed` | Replace `inbox`. |
| `settings.changed`, `spend.changed` | Replace. |
| `compaction.started` / `.ended` | Add or remove by `taskId`. |
| `retry.scheduled` / `.cleared` | Set or clear `retry`. |
| `task.failed` | Append to a transient error list shown in the transcript. |
| `approval.requested` / `.resolved` | Add, or remove by `approvalId`. |

Convergence: applying the first snapshot and every later event must give the same state as applying any later snapshot and the events after it. `test/fixtures/durable-1.1.0/10-late-join.full.jsonl`, `10-late-join.jsonl` and `10-late-join.mid-answer.jsonl` record one run from three attachment points and are the test for this. The omissions in 4.5 exist to make it hold. Item windowing breaks it only beyond `snapshotItems`, where `hasEarlier` says so.

### 7.4 Worked example

Durable batch `02-tool-round:14` (abridged):

```json
[{"type":"tool_execution_end","toolCallId":"call-1","toolName":"count","entry":{"kind":"pi.tool-result","id":13,"model":[{"role":"toolResult","toolCallId":"call-1",…}],"data":{"diagnostics":[]}}},
 {"type":"message_start","message":{"role":"toolResult",…}},
 {"type":"message_end","entry":{"kind":"pi.tool-result","id":13,…}}]
```

Wire frame:

```json
{"type":"event","subscription":"s3","seq":11,"events":[
 {"type":"tool.ended","callId":"call-1","resultId":13},
 {"type":"item.added","item":{"id":13,"type":"toolResult","at":1791840744884,"callId":"call-1","toolName":"count",
   "content":[{"type":"text","text":"1\n2\n3\n4\n5\n"}],"isError":false,"details":{"counted":5},"diagnostics":[],"durationMs":507}}]}
```

## 8. Approvals

pi-durable 1.1.0 has no approval concept. The server builds one from a `beforeTool` hook in its own extension. The fixtures show the building block: an async `beforeTool` hook can wait, and while it waits the stream is silent. The assistant's tool-call entry is the last event (`12-approval-hook:6`), and `tool_execution_start` follows only after the answer (`12-approval-hook:9`).

Server behaviour:

1. The server's approval policy says which tool calls need approval (`host.info` `tools[].requiresApproval`). The policy is server configuration, not protocol.
2. The hook creates `Approval` with `approvalId = "<conversationId>:<callId>"` and emits `approval.requested` to that conversation's watchers. The summary's `pendingApprovals` and `status` change on `host.watch`.
3. It waits for `approval.answer`, or for the hook context's abort signal.
4. On `approve` it returns `undefined` and the call runs. On `deny` it returns `{block: "Denied by <login>: <message>"}`. The model sees a blocked error result, as in `08-blocked-tool:8`.
5. `conversation.abort()` fires the hook context's abort signal at once (`16-approval-abort:8` to `:9`). The hook then emits `approval.resolved` with `decision: "cancelled"` and returns. pi-durable ignores the return value and writes its own error result with diagnostic `aborted` (`16-approval-abort:10`).
6. It emits `approval.resolved` with `decision` and `by` (the answering login) to watchers.

Approval events are not durable commits, so they travel in their own frames. `approval.requested` always follows the frame that added the tool call's assistant item.

While the hook waits, the durable slot is `pending` (`15-approval-crash-resume:11`). Section 4.5 omits pending slots, so the client sees the call only through `approvals`.

Restart: pending approvals live in server memory. After a crash, `resume()` reruns the tool task, and the hook runs again because no intent was recorded (`15-approval-crash-resume:8` and `:13`, from two processes). The hook raises the same `approvalId`. An answer given just before a crash may be asked for again.

## 9. Reconnects, resync and restarts

### 9.1 Client reconnect

- On any socket failure the client reconnects with exponential backoff: 0.5 s doubling to 30 s, with full jitter, reset after a connection survives 60 s.
- After `welcome` it repeats every `host.watch` and `conversation.watch` it had and receives fresh snapshots. Nothing is replayed (pi-durable spec §9.4). The client discards subscription IDs from the old connection.
- Requests without a response when the socket dropped have unknown outcomes. The client retries automatically only those that are safe to retry: `submit`, `conversations.create` and `conversations.fork` (deduplicated by `requestId`), and `configure`, `conversations.archive`, `abort` and `approval.answer` (idempotent). It does not retry `compact` or `reset`; it tells the user they may or may not have applied, and the next snapshot shows which.
- Unsent user messages stay in a local outbox with their `requestId` until a `submit` response arrives.

### 9.2 Falling behind

- pi-durable keeps at most 100 undelivered batches per stream, then replaces them with one snapshot (`14-overflow-snapshot:6`). The server turns that into a wire `snapshot`.
- The server also bounds its own send queue per subscription, at 256 frames or 8 MiB. When the bound is reached, it drops that subscription's queued frames and queues one fresh `snapshot`.
- Either way the client just applies the snapshot.

### 9.3 Server restart

1. The server opens the SQLite store and installs the same extensions.
2. It calls `harness.resume()` before it starts listening.
3. Interrupted work then settles within milliseconds, before a client can attach. A tool that is not replay-safe gets an error result with diagnostic `interrupted` (`11-crash-and-resume:18`). A replay-safe tool reruns: its output resets, and it sends `details: null` and `diagnostics: []`.
4. A client that attaches in that window sees the interrupted slot as `running` (`11-crash-and-resume:15`), and the next frame corrects it.
5. A task that stays blocked, for example because its extension is missing, appears as `status: "stuck"` in `host.watch`.
6. On shutdown the server sends `goodbye` with `reason: "shutting_down"` and closes with 1001.

### 9.4 Harness failure

A storage error closes the Harness (pi-durable "Errors", rule 1). The server ends every subscription with `end` `reason: "host_restarting"`, answers requests with `unavailable`, reopens the store, and resumes. Clients watch again after backoff.

## 10. Review decisions

Reviewed 2026-10-12.

Accepted:

1. **`steer` is `submit` with `whenBusy: "steer"`.** There is no separate method.
2. **Snapshots send at most 200 items.** Older items load through `conversation.history`.
3. **Approval restart and abort behaviour.** Recorded after review as fixtures 15 and 16. `beforeTool` reruns after a crash, and `conversation.abort()` aborts a waiting hook (section 8).
4. **Reset and compact are not deduplicated in v1.** The client never retries them automatically.
5. **Tailscale is required.** There is no token or pairing mode.

Added 2026-10-12, as optional fields within v1:

6. **Projects.** aludra's host serves v1 at `/app` and ties each conversation to a project: `host.info` lists `projects`, summaries carry `workspace`, `project` and `dir`, `conversations.create` takes `project` and a first message `text`, and `configure` refuses `cwd` and `tools`. Forks answer `unsupported` there. Since 2026-10-13 aludra archives as section 5 describes: `conversations.archive` is idempotent and returns the summary, `conversations.list` leaves archived conversations out unless `includeArchived` is set, and `host.watch` carries them with `archived: true`. Archiving only hides a session; a running one keeps running. Approvals carry an extra `summary` ("git push"). A create without a project makes a no-project session (T3 Code's no-project threads): its own scratch directory, no `project` in its summary.

Added 2026-10-13, also optional within v1 (aludra serves them; a server without them answers `unknown_method`):

7. **Renaming.** `conversations.rename {conversationId, title}` returns `{conversation}` with the new title, and watchers get `conversation.updated`. aludra folds whitespace and takes 1 to 200 characters; anything else is `bad_request`. aludra also retitles a new session itself: a second or two after the first message, a small model's title replaces the first-line one and arrives as `conversation.updated`. A rename by the user always wins over it, so clients show the summary's latest `title` and keep no title of their own.
8. **Picked project colours.** A project's colour is hashed from its name (`ProjectColor`), and names can clash. `host.info` and `host.snapshot` carry `projectColors`, project name to an index into `ProjectColor.hues`; `projects.setColor {project, color}` sets one (`color: null` clears it, so the name's hue is back) and returns `{projectColors}`; `host.watch` sends `{"type":"host.projectColors","projectColors":{…}}` when they change. A client that doesn't know the event resyncs once.

9. **Images.** `submit` and `conversations.create` take `images: [{mimeType, data}]` (base64) beside `text`, which may then be empty. aludra takes PNG, JPEG, GIF and WebP, at most 8 a message and 5 MB each, and checks the bytes are the type named; the Mac app scales each to 1568 px on the long side first. Image blocks in items still carry only `mimeType`; `conversation.image {conversationId, entryId, index}` returns `{mimeType, data}` for block `index` of item `entryId`, a user message's or a tool result's.

10. **Charged cost.** A `ConversationSummary` carries `cost`, the dollars providers that bill each request (OpenRouter) charged for it, only when it used one. `host.info` and `host.snapshot` carry `monthCost`, this calendar month's charged total, only when something was charged. No event carries `monthCost`, so the Mac app reads `host.info` again (at most once a second) when a summary's `cost` changes. It writes amounts as `<$0.01`, `$0.42`, `$12.30`, `$140`.

Added 2026-10-23, outside v1: aludra's own extensions (aludra 861c0f3), which other v1 servers need not serve:

11. **Host settings.** `settings.get {}` returns `{settings}`, and `settings.set {changes: {key: value | null}}` saves the changes and returns the new `{settings}`; `null` puts a setting back to its default. `settings` is aludra's `Settings` (its docs/api.md, "Settings"): `{file, settings, restart, errors}`, where each `Setting` describes itself (`key`, `label`, `help`, `kind`, `value`, `default`, `set`, `options`, `editable`, `live`) so a client draws its form from the list. A refused change is `invalid_settings` with `data.errors`, one reason each, and nothing is saved. A host without them answers `unknown_method`, and the Mac app offers no settings for it. After a save the Mac app reads `host.info` again, since projects, models and defaults come from the settings.

Added 2026-10-29, aludra's own extension like 11:

12. **Videos.** `submit` and `conversations.create` take `videos: [{name, mimeType, data, seconds?, frames?: [{mimeType, data, at}]}]` beside `images`. aludra takes MP4, QuickTime or WebM, at most 2 a message and 40 MB together, checks the bytes are the type named, and takes up to 6 frames each, checked as images. No model takes video, so aludra saves each in its data directory for 14 days and the user message carries a text block `<video name="…" seconds="…" path="…" until="YYYY-MM-DD">…</video>` for the agent, followed by the video's frames as image blocks. The Mac app re-encodes a video to 720p H.264 MP4 (540p if that's over the limit), sends frames from start to end, and shows the note as the video's name, length and how long the host keeps it (`TranscriptVideo`). `host.info` carries `videos: {maxVideos, maxBytes, maxFrames, keepDays}` on a host that takes them; the app sends no video to one without it, since an older aludra drops the field without a word.

Added 2026-10-30, aludra's own extensions like 11 (aludra 2899ef8 to 3568dcf). A host without a method answers `unknown_method`, and one without a `host.info` field leaves it out; the Mac app then offers none of it, so older hosts keep working.

13. **Archiving on the host.** aludra archives a session idle `archive.afterDays` (default 3, `0` for off) with nothing running or waiting, a minute after it starts and hourly, and clients hear of it as `conversation.updated` with `archived: true`, as of any archive. A session brought back with `conversations.archive {archived: false}` is kept: the host leaves it until someone archives it again. `archive.afterDays` is a `number` setting in `settings.get`, so the settings form shows it like any other. The Mac app archives nothing on its own and keeps no list of its own; before 3568dcf it archived sessions three days idle itself, and a host from before that archives nothing.
14. **Regenerating a title.** `conversations.retitle {conversationId}` has a model write the title again from the whole conversation and returns `{conversation, written}`; watchers get `conversation.updated` when it's written. It replaces any title, one set by hand too. `written: false` means no model answered and the title stayed. A session with no messages is `bad_request`. The Mac app offers Regenerate Title beside Rename… in a session's menu, disabled before the first message (a summary whose `updatedAt` is still its `createdAt`), says how it went where the undo bar goes, and doesn't send it again after a dropped connection, since each is a model call. A host that answers `unknown_method` isn't offered it again until it reconnects (`HostStore.has`).
15. **Checkpoints.** In a project in git, aludra snapshots the project's files as each turn starts. `checkpoints.list {conversationId}` returns `{checkpoints: [{id, at, tree, kind, message?, restored?}]}`, oldest first. A `kind: "turn"` checkpoint's `message` equals the `at` of the user item whose turn it starts; a `kind: "restore"` one is the files just before checkpoint `restored` was put back. `checkpoints.changes {conversationId, checkpoint}` returns `{changes}`, aludra's `Changes` (`{available: true, since, add, del, files: [{path, old?, add, del, binary, status}]}`, or `{available: false, reason}`) from that checkpoint to the next, or to now for the latest; with `path` it returns `{path, patch}` for a file in those changes. `checkpoints.restore {conversationId, checkpoint}` puts the files back and returns `{written, deleted, files, undo}`, where `undo` is the restore checkpoint taken first; restoring `undo` takes it back. A restore while the session runs or waits is `busy`. The session's next user message then starts with a text block `<restored checkpoint="N">…</restored>` for the agent. The Mac app reads the list after each snapshot and each run's start and end, offers `[changes · restore]` on hover and Changes and Restore… in the menu of a user message whose turn has a checkpoint, shows what the turn changed with each file's patch on a click, confirms before restoring, then lists what changed with an undo, and draws the note as a "files restored to checkpoint N" line. Restore checkpoints are only ever undo targets. Restore isn't sent again after a dropped connection, since a second one would record the restored files as the undo point.
16. **Message search.** `messages.search {query, conversationId?, limit?}` returns `{results}`, best first: `{session, entry, index, item, from, at, snippet, title, project, workspace, archived?}`, for the messages and answers holding every word (the last as a prefix). Tool calls and their output aren't searched; archived sessions are, their results marked. `entry` is the item's entry ID in `conversation.history`, and `snippet` marks the matched words between « and ». The Mac app searches every connected machine as the sidebar's search is typed (a quarter second after the last key, two characters or more) and shows a messages section under the title matches; the spotlight (⌘/) lists them under its projects. One host's ranks don't compare with another's, so the lists are merged a rank at a time (`SearchMerge`). A result opens its session, pages `conversation.history` back until its entry is loaded, and scrolls to the item's first row (`TranscriptLayout.rowID`), lit for a moment. A host that answers `unknown_method` isn't searched again until it reconnects.
17. **Files and long text.** `host.info` carries `files: {maxFiles, maxBytes, pasteBytes, keepDays, maxMessageBytes}` on a host that takes files, and then `submit` and `conversations.create` take `files: [{name, mimeType?, data}]` (base64, any kind): at most `maxFiles` (20) and `maxBytes` (25 MB) together, a message's images, videos and files together at most `maxMessageBytes` (80 MB, to fit the socket's frame as base64). aludra saves each in its data directory for `keepDays` and the user message carries a text block `<file name="…" type="…" bytes="…" path="…" until="YYYY-MM-DD">…</file>` for the agent. Message text over `pasteBytes` (32 KB) in UTF-8 is saved the same way as `message.txt`, and the message keeps its first 1,500 characters or so; that needs nothing from a client. The Mac app's attach button (a paperclip on such a host), drops and pastes take any file: images still go as images and videos as videos, anything else as a file, shown as a chip with its name and size, removable before sending. It checks the limits before sending (`AttachmentBudget`) and sends no files to a host without `files`, since an older aludra drops the field without a word. In the transcript, each `<file>` note is a chip with the file's name, size and how long the host keeps it (`TranscriptFile`), its path in the tooltip and Copy Path on Host.
18. **Visual replies.** A host whose `host.info` has `pages: true` gives the agent a `publish_page` tool, and its result's `details` are `{page, title, bytes}`. `conversation.page {conversationId, page}` returns `{page, title, html, bytes, createdAt, csp}`; a page never changes once published. The `html` carries its own Content-Security-Policy, and `csp` is the same policy for a client to enforce as well. On such a host the Mac app shows the page in place of its call (`TranscriptPage`, keeping the call's row), above the answer after it: its title, then the page in a web view sized to its content up to a cap, with a button that opens it full screen. The web view loads `html` from a string with the `csp` added as a meta tag, JavaScript on, a non-persistent data store and no bridge to the app; any navigation it starts opens in the default browser and is canceled. Pages are fetched once per session and page. A host without `pages` shows the call as any other.

Added 2026-11-04, aludra's own extension like 11, agreed in design (aludra's sandbox commits 87af194 to 030ed16 serve the same through its CLI and HTTP API). aludra serves the sandbox basics (aludra c7c018e), approvals (aludra 9a7c1fe), checkout state (aludra 290506c) results with `line`, `task.result` and `task.code` (aludra 0bb3f26), screenshots (aludra 6820af2), and ships on the summary, pushes and groups (aludra 94b2845). A host without `host.info.sandboxes` offers none of it.

19. **Sandbox tasks.** A session may run its tools in a sandbox: a VM of its own on another machine, made from the project's last commit, which reaches the internet and nothing else, holds no keys and can't push. The model, transcript and approvals stay on the host. Its work comes home as the branch `sandbox/N` in the project's checkout, and shipping lands it upstream with the host's git. The Mac app shows a session as a task: a line in a list grouped by what it needs from you, and a result page (what it did, checks, what changed for someone using it, screenshots, heads-ups) with the conversation a tab away.
    - `host.info` carries `sandboxes: {shipTo: "main" | "branch", afterRun: "off" | "fetch" | "merge", approvals: "ask" | "off"}` on a host with a sandbox host. `approvals` is the default for sandbox sessions; `off` runs `git push` and SSH to the approval hosts without asking, since the sandbox has no remotes, keys or route to them. It is not "no guardrails": the protected-path gate stays on, since the sandbox holds the project's committed files and anything a tool reads lands in the transcript on the host and with the model's provider. Each `projects` entry gains `checkout: {branch?, dirty, ahead, behind, upstream?, sandboxes: true | {reason}, checks?, code?}`: `checks` is how many checks the last commit's `.agents/project.json` declares and `code` whether that commit has something to check (a package manifest, Makefile or the like), so the app offers Set up checks only for a project with code and no checks (aludra from 2026-11-05; without them it offers it until a setup task has run). Then the checked-out branch (absent when detached), uncommitted paths (untracked included), commits ahead of and behind its upstream as last fetched (the host never fetches to work them out), and whether a sandbox can start from it. `checkout` is on every host, with or without a sandbox host, since the project table is useful anyway. A project can't take a sandbox when the host has no sandbox host, it isn't in git, it has no commits yet, or it's inside a bigger repository (a template clones the whole repository). `host.watch` sends `{"type": "host.projects", "projects": [...]}`, the whole list, when any checkout changes, read at most every 5 s while a client watches.
    - A template is the checkout's last commit, so uncommitted local work isn't in the sandbox. With `checkout.dirty > 0` the app says so when starting a sandbox task ("3 uncommitted changes here won't be in it").
    - `conversations.create` takes `sandbox: true` and, with it, optional `approvals: "ask" | "off"`. It answers at once; the sandbox is made after.
    - A sandbox session's `ConversationSummary` carries `sandbox: {number, branch, state, approvals, base, step?, reason?}` and `source` (the project's directory on the host; `dir` is then in the sandbox). `number` is the host's own, one count across projects that's never reused, and `branch` is `sandbox/<number>`. `state` is `preparing` (with `step`: `waiting`, `cloning`, `installing`, `saving` or `starting`), `ready`, `paused`, `failed` (with `reason`) or `removed`. `paused` is informational: the sandbox host pauses an idle sandbox and any tool call wakes it in under a second, and the host reads it about once a minute, so the app treats `ready` and `paused` alike. `base` is the commit it started from. `approvals` is what the session follows, its own or the host's, so the app can mark a task that will ask. Summaries also carry `line`: one short sentence of where the session stands, for the task list ("Grouping items by bag", "Ready · checks pass", "Asks: drop the image plugin?"), set by the host from the plan, the result or the open question. `conversation.updated` carries changes to either.
    - The first user message of a session that's `preparing`, and any `submit` before it's `ready`, is held by the host (a restart doesn't lose it) and sent in order once it's `ready`. A held `submit` answers `{submission: {requestId, type: "input", status: "queued"}}` with no `id`; it gets one once sent, with the same `requestId`, so the client matches held messages by `requestId` and a retry is still exactly once. `abort` doesn't withdraw a held message. While a message is held the summary's `status` is `busy`; a preparing session with nothing held is `idle`. A sandbox that fails leaves the message unsent and the session `status: "stuck"` with `stuck: {reason: "sandbox_failed", detail}`; the app shows `sandbox.reason` for the text. Later messages are `bad_request`; a new session tries again.
    - **Results.** A run that ends with an answer records a result for its turn. `task.result {conversationId}` returns `{result}` for the latest, or `{result: null}` before one:
      `{at, summary, changes: ["…"], headsUp: [{kind, text}], checks: [{name, ok, detail?}], shots: [{id, label, side: "before" | "after", path?}], code: {commits, files, add, del}, plan?: [{text, done}], question?: {text, why?, options: ["…"]}}`.
      `summary` and `changes` are plain sentences for someone who uses the project, not its code. `headsUp` kinds are `upstream` (the upstream changed what the work touches), `dependency`, `left` (uncommitted in the sandbox) and `other`. `checks` come from the project's declared check commands (`checks` in `.agents/project.json` in its repository) run in the sandbox once a run ends with an answer, or from the turn's own test and build calls until they've run or when none are declared. `code` waits for `sandbox/N` to come home (zeros before). `task.result` works for any session; outside a sandbox `code` is zeros. `question` is set when the turn ends asking you something; its `options` become buttons that send the option's text. aludra asks the agent for this shape in the session's prompt and parses it from the answer's last block, falling back to `summary` alone. `plan` is the agent's own checklist, a fenced `plan` block of `- [ ]` and `- [x]` lines it writes again as it goes, and the `result` block is fenced JSON at the end of each reply; the app hides both blocks when it shows the answer as prose. `task.result` during a run returns `{result: {plan, at}}`, `plan` being `[]` until the agent writes one, and `conversation.updated` signals a change through `line`.
    - `task.shot {conversationId, shot}` returns `{mimeType: "image/png", data}` (base64). A shot past its 14 days, or an unknown `id`, is `not_found`, which the app shows as a missing image, not an error. Shots are taken in the sandbox with a headless browser once a run ends with an answer, after the declared checks: the project's declared pages first, then the pages its changed routes make (TanStack Router, Remix, SvelteKit, Astro and Next's app router, from file names; dynamic routes skipped), at most 6, at 1280×800. `before` is at `base`, the sandbox's starting commit, over every turn; `after` is at HEAD. A page that fails to load or answers 400 or more is left out on that side, so a new page has only an `after` and a removed one only a `before`: the app pairs shots by `path` and shows a lone side alone. `label` is the declared label, or the path; `path` is always set. `shots` is `[]` while they're taken, and `line` then ends `· taking screenshots`; `conversation.updated` carries the line change when they land, and the app reads `task.result` again. A host restart meanwhile leaves that answer without shots until the next run ends. A ship waits for them. Screenshots are opt-in per project: the base template carries no browser, so a project that wants them has `playwright` or `@playwright/test` among its dependencies, installs Chromium in its `.agents/setup` (`pnpm exec playwright install --with-deps chromium`), and declares beside `checks` in `.agents/project.json` `devServer: {command, port}` (the server gets `PORT`) and `pages`, paths or `{path, label?}`, default `/`. A project without a dev server or a browser has none, without a heads-up.
    - `task.code {conversationId, path?}` returns `{changes}` in the shape of `checkpoints.changes` (section 10 item 15) for `sandbox/N` against its `base`; with `path`, `{path, patch}`. It's behind the result's "show the code" line.
    - `sandbox.sync {conversationId, merge?}` fetches now and returns `{branch, head, commits, uncommitted, merged?}`: `commits` new on the branch, `uncommitted` files left in the sandbox, and only with `merge`, `merged: true | {reason}`.
    - `sandbox.ship {conversationId, to?, note?}` starts a ship and answers `{started: true}` at once. `to` is `main` or `branch` and defaults to `shipTo`; `note` is added to the ship prompt. The ship runs as a normal turn, so watchers see it stream, and the summary's `line` follows it. When it ends, every `host.watch` gets `{"type": "sandbox.shipped", "conversationId", "shipped": true, "to", "pushed", "head", "commits", "pr"?}`, where `to` is the mode and `pushed` the remote branch (`origin/main`, `origin/sandbox-4-ab12cd3`), or `{"type": "sandbox.shipped", "conversationId", "shipped": false, "kind", "reason"}`. `kind` is `blocked` (the run didn't end with `SHIP-READY`: it asks something, was stopped, or its model failed), `upstream_moved` (the push was refused because the upstream moved; ship again), `push_failed` (git or gh couldn't do it against the upstream) or `check_failed` (the host's own checks before pushing: files left uncommitted, the branch not on the upstream, no upstream). Work with nothing beyond the upstream once rebased lands with nothing pushed: `shipped: true, to: "main", commits: 0` (aludra from 2026-11-05; before, `check_failed` "nothing to ship"), which the app shows as "Already on main" and files under done. A `blocked` ship with a question puts it in the turn's result once results are served; until then the app shows `reason` with a free-text reply, not buttons. Sending `sandbox.ship` is the approval of the push. A ship while the session runs or already ships is `busy`.
    - A sandbox session's summary keeps how its ships went, so a client that wasn't watching (or restarted) still knows: `sandbox.shipped: {at, to, pushed, head, commits, pr?}` once a ship lands, kept until a later one replaces it, and `sandbox.shipStopped: {at, kind, reason}` for the latest ship that didn't, cleared when the next ship starts or lands. `conversation.updated` carries both. The `sandbox.shipped` event stays, for the moment it happens. The Mac app groups a session with `shipped` as done ("Live on main") and one with `shipStopped` as needing you, and uses the event only on a host without them (aludra 94b2845).
    - `sandbox.discard {conversationId}` deletes the local `sandbox/N`, unmerged commits and all, and returns `{branch, deleted}` (`deleted: false` when there was no branch); the sandbox stays. Archiving after a discard removes the sandbox without fetching its commits back, and a later `sandbox.sync` brings the branch back. Archiving still removes the sandbox, as aludra's CLI does.
    - Dropped 2026-11-04: ×3, one ask run in three sandboxes to keep the best. aludra 94b2845 serves `group` on `conversations.create` and the summary, and `group.keep`, but no client sends them, and aludra may remove them.
    - The Done push says what came back ("Done · 2 commits on sandbox/4", "Shipped to main", "Ship stopped: …"), and a `question` push says it needs you.
    - Later, not part of this item: a live preview of the sandbox's dev server through the host with pins that become message parts, "try it here" (`sandbox/N` in a worktree beside the checkout, served on the host), and a shell in the sandbox.

Added 2026-11-04, aludra's own extension like 11 (aludra c3e5fc6 new projects, ba8166a scratch sandboxes and `sandbox.promote`, fb29d8f `.agents/resume` and sizes, ff08223 the plan). A host without `host.info.newProjects` offers no new projects.

20. **New projects, scratch sandboxes, resume and sizes.** Every repo starts on the host: a new project is made there, with its first commit and a private GitHub repository, so every task after it can run in a sandbox, the first one included. Scratch work can run in a sandbox too, and become a project when it's worth keeping.
    - `host.info` carries `newProjects: {root, owner}` on a host that can make them now: `root` the directory new projects go in (aludra refuses a root no workspace root lists the folders of, so a new project always lists at once), `owner` the GitHub account or organization. It's absent when the settings don't name them or `gh` isn't signed in to github.com (read at most once a minute), and then the app hides New project.
    - `projects.create {name, description?}` makes `<root>/<name>`, `git init` on `main`, a `README.md` with the name and description, a first commit with the host's git identity, then a private `<owner>/<name>` created with gh and pushed. `origin` is `git@github.com:<owner>/<name>.git`, so pushes and ships use the host's SSH key as for its other projects. It returns `{project}`, the new `ProjectInfo` with its `checkout`, and every `host.watch` gets `host.projects`. `name` is lowercase letters, digits and `-`, starting with a letter or digit, not ending with `-`, at most 100 characters. It's `bad_request` for a bad name, for an existing folder or repository (the message says which), and for a host that can't make projects now (the message says why, for a client whose `host.info` was stale); `internal` when git or gh fails after it started. A failure removes the folder it made; a repository gh had created is left on GitHub, and the message says so. Not sent again after a dropped connection. A project made this way can take a sandbox at once.
    - `conversations.create` with `sandbox: true` and no `project` makes a scratch sandbox. Its repository on the host is `scratch/<id>/` in the data directory, whose `main` is one empty commit, the same commit for every scratch session (fixed dates, the host's identity), so they share one template. In the sandbox it's at `/home/user/work/scratch`, which is the summary's `dir`; `source` is the repository on the host, `project` is absent, and `sandbox` is as for any sandbox task. The agent is told it's scratch work: commit as it goes, nothing ships. `sandbox.sync`, `task.result`, `task.code` and checks work against the empty commit; `sandbox.ship` is `bad_request` ("no upstream to ship to; make it a project first").
    - `sandbox.promote {conversationId, name, description?}` makes a scratch sandbox's work a project: it fetches the sandbox's commits, then `projects.create` makes `name` with them as `main` in place of a first commit, and pushes. The answer is `projects.create`'s. The session then belongs to the project: its summary's `project` is the new name and `source` its folder, `sandbox.base` is the new `main`, and `sandbox/<number>` in the new project points at it, so the next run's work comes home there and Ship lands on its `origin/main`. Nothing more is pushed until a ship. It's `bad_request` for a session that isn't a scratch sandbox, is running, has no sandbox, or has uncommitted files in its sandbox ("ask the agent to commit first"), and for anything `projects.create` refuses. Not sent again after a dropped connection.
    - `.agents/resume` in a project, if executable, runs in the sandbox as `user` from the project's directory when the connection to a paused sandbox opens, before the first call on it, at most 60 s; a failure or timeout is logged in the host's log and the call goes on. The sandbox host pauses only sandboxes nobody is connected to, so a connection can't find its sandbox paused under it. For refreshing what a pause stops, such as a dev server.
    - A sandbox has a size: `small` (2 CPUs, 4 GB), `medium` (4, 8 GB) or `large` (8, 16 GB). `conversations.create` takes `size` with `sandbox: true`; without it the session takes `size` from `.agents/project.json` at the commit its template is made from, else `small`, and the template is made at that size. `size` without `sandbox`, or another value, is `bad_request`. The summary's `sandbox.size` appears once the sandbox starts being made, not at create, so a client reads a missing `size` as not known yet, not as small. Brad's sandbox host gives all three.
    - The Mac app offers + New project in the project picker and on the projects home: a sheet with the name, checked as it's typed against the rule above and the machine's projects, an optional description, and where it goes (`<root>/<name>`, private on `github.com/<owner>`), with the host's refusal shown in the sheet. On success the new-task box opens on the new project, set to sandbox. Scratch in the picker runs in a sandbox where the host has one, and here otherwise. A scratch sandbox's header has Make it a project in place of Ship, the same sheet with a name suggested from the task's title, sending `sandbox.promote`. The new-task box has a size (auto, small, medium, large) for a sandbox, and the task header shows the size once known.

Deferred, not in v1:

- Withdrawing one queued message (`harness.abortSubmission`). `abort` withdraws all queued inputs.
- A fixture for deferred polling. Faux can return deferred handles, so it can be recorded before a provider needs it.
