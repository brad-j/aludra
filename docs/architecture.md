# Architecture

How aludra works today. [plan.md](plan.md) has the history: what was decided, when, and why.

## The pieces

```
 an API client                 amyrlin (macOS)             terminal
        │ HTTPS + WS /api/live        │ WSS /amyrlin             │
        └──────────────┬──────────────┘                          │
               tailscale serve  (adds Tailscale-User-Login)      │
                       │                                         │
               127.0.0.1:8724                          aludra.sock (Unix socket)
                       │                                         │
 ┌─────────────────────┴─────────────── aludra serve ────────────┴──────┐
 │  src/api.ts  ── the HTTP API and the /amyrlin endpoint                │
 │  src/server.ts ── the CLI's socket                                    │
 │  src/live.ts ── the live feed both sockets share                      │
 │  src/host.ts ── Pi Durable Harness over aludra.sqlite                 │
 │     extensions: CodingTools · context · claude-code · permissions     │
 │  src/claude-code.ts ── pi-claude-code as a pi-ai provider             │
 └───────────────────────────────┬───────────────────────────────────────┘
                                 │ claude -p, stream-json
                       Claude Code (claude.path), the user's own login
```

One long-lived Node process, `aludra serve`, owns the SQLite file and runs every session. amyrlin, the CLI and anything else on the API are clients; none of them hold state that matters, and none is served by the host: there's no web app.

## The host

`src/host.ts` opens a Pi Durable 1.3.0 `Harness` over `aludra.sqlite` in the data directory and calls `harness.resume()` at start, which continues whatever the last process left unfinished.

- **A session is a Pi Durable conversation**: ownerless, with its agent's `cwd` set to the project's directory, and its own model and thinking level. Session IDs are the conversation IDs, so they start at 7 rather than 1.
- **A no-project session** gets `scratch/<id>` in the data directory as its `cwd`, set in the same commit that creates the conversation.
- **aludra's own records** are Pi Durable documents on the root conversation:

  | Document | Holds |
  | --- | --- |
  | `aludra.sessions` | Each session's workspace, project, directory, title and who wrote it (a model or the user), whether it's archived, creation time, and changes snapshot. |
  | `aludra.ideas` | Ideas, by ID. |
  | `aludra.approvals` | Approval requests and decisions; decided ones are dropped after a week. |
  | `aludra.colors` | Picked project colors: name to hue index. |
  | `aludra.push` | Devices signed up for notifications. |
  | `aludra.amyrlin` | The host's ID for amyrlin, and `conversations.create` request IDs already handled. |
  | `aludra.checkpoints` | Each session's checkpoints (a git tree each, by hash), and a note about a restore for its next message. |

- **Extensions**, installed in this order:
  1. Pi Durable's `CodingTools`: `read`, `write`, `edit` and `bash`, each run in a `NodeExecutionEnv` from the conversation's `cwd`.
  2. Project context (`src/context.ts`): `AGENTS.md` or `CLAUDE.md` and skills, found with pi-coding-agent's own loaders the way the pi coding agent finds them, and read again before every request. A no-project session gets a `no_project` section instead, saying where things are on the machine.
  3. The Claude provider's extension (`src/claude-code.ts`), which records each conversation's `cwd` for the provider.
  4. Checkpoints (`src/checkpoints.ts`), a `beforeRequest` hook that snapshots the project as each turn starts.
  5. Permissions (`src/permissions.ts`), last, so it wraps every tool the others bring.

## Model providers

Pi Durable gets one pi-ai `Models` collection: pi-claude-code when `model.choices` names a Claude model, and pi-ai's own `openai` and `openrouter` providers always, with a credential store over `credentials.json` in the data directory (`src/credentials.ts`). Sessions can change provider between requests, since every provider is handed the whole transcript.

- **OpenAI** is pi-ai's own `openai` provider, which Pi Durable drives directly, with nothing in between. `aludra login openai` (`src/login.ts`) runs pi-ai's Sign in with ChatGPT flow with the machine's installation ID, and the store keeps and refreshes the tokens. The store reads the file for every request, so a login from the CLI reaches a running host; a lock file keeps the CLI and the host from writing at once.
- **OpenRouter** is pi-ai's `openrouter` provider and its catalog of several hundred priced models. `aludra login openrouter` runs pi-ai's OAuth flow, which leaves an API key in the store.
- **Claude** goes through Claude Code, below.

`src/catalog.ts` lists every model a session can run on: each provider this machine is signed in to, OpenAI's narrowed to what the ChatGPT account offers (asked of the account hourly). The pickers search it; `model.choices` are pinned above it. Costs come from pi-ai, which prices each answer from the catalog; A session's `cost` is `billedCost` in `src/transcript.ts`: the OpenRouter part of its usage ledger (Pi Durable's `pi.usage`, keyed `provider/modelId`), which counts compaction summaries too. The month's total is `spendOf`, which adds up answers by their time; the ledger has no times, so that total leaves out compaction summaries.

### Claude Code

`src/claude-code.ts` loads [pi-claude-code](https://github.com/earendil-works/pi-claude-code), a pi-ai provider that uses the user's own Claude Code (`claude.path`, run as `claude -p` with `stream-json`) as the model and nothing else. Pi Durable keeps the history, compacts it and runs the tools. Each turn the provider hands Claude Code the transcript, Pi's system prompt and an inert list of Pi's tools; Claude Code returns the model's answer and tool calls without running any, and writes no session files. A turn that exactly continues the last one may reuse that session's warm Claude Code process (two at most, five minutes each). Anything else (a tool call, a restart, a compaction, a reset, a change of model or directory) starts a fresh process that replays the transcript, so none of those need glue in aludra.

The package ships TypeScript, which Node won't strip inside `node_modules`, so its provider module loads through jiti, with its pi-ai imports pointed at the copy Pi Durable uses. The wrapper around it does three things:

- **The working directory.** Claude Code tells the model its process's directory, and the provider reads `process.cwd()` synchronously when a request starts, so the wrapper changes into the conversation's directory around the call.
- **The ID.** Its models run under aludra's provider ID, `claude-bridge`, which sessions and settings already name.
- **The catalog.** Its built-in model list trails Claude Code's. The host and doctor ask Claude Code which models the account offers (a control request, no model call), and the list is then only those, less Claude Code's `default` alias.

`claude.path` reaches the provider as `PI_CLAUDE_CODE_COMMAND`, set in the host's environment before it loads, and Claude Code inherits `CLAUDE_CONFIG_DIR` from the host. The provider refuses to start Claude Code when the environment names an API key, a base URL or another backend (Bedrock, Vertex, Foundry), and fails a turn that Claude Code reports was charged to usage credits rather than the plan. Each answer carries Claude Code's latest rate-limit status as a `claude-code.rate-limit` diagnostic: the five-hour and seven-day windows, their use and when they reset.

pi-claude-code isn't on npm, so it's pinned to a commit, and Pi Durable to its version; `aludra doctor` fails if either changes version. `test/claude-code.test.ts` tests the wrapper, and `scripts/live-check.ts` runs the real thing ([operations.md](operations.md#upgrading-pi-durable-or-pi-claude-code)).

## Titles

`src/titles.ts` writes each session's title from its first message once it's submitted, in the background: a one-off request (`cacheRetention: "none"`, which pi-claude-code runs as its own Claude Code process with no tools, apart from any session's) to the smallest model on hand, then the next if one fails. The host records who wrote a title, so a rename by hand is never replaced, and announces the change like a rename. Writing a title again (`regenerateTitle`) sends an excerpt of the conversation instead: the first message, then the latest messages and answers that fit in 6,000 characters, without tool calls, each cut to 1,200. It replaces a title set by hand, unless the title was renamed while the model wrote. The faux model writes none.

## Permissions

A `beforeTool` hook asks for approval: it opens a request in `aludra.approvals` keyed by a memoized ID, so a restart waits on the same request, and waits for a decision, an expiry, a stop, or a new message from the user. The protected-path gate wraps `read`, `write`, `edit` and `bash` instead of using a hook, because ending the run on the second block needs a tool result with `control.terminate`, which a hook can't return. [security.md](security.md#permissions) has the rules.

## Clients

- **The CLI** (`src/cli.ts`, `src/server.ts`) sends one JSON request per connection over `aludra.sock` and prints the lines that come back. Live output comes from Pi Durable's `watchEvents()`. `aludra sessions` gets the session summaries as data instead and lays them out for the terminal (`src/listing.ts`), with pi-tui's width handling.
- **The HTTP API** (`src/api.ts`) serves HTTP for actions and one WebSocket, `/api/live`, for everything live, from the feed in `src/live.ts`. A followed session's transcript is built from Pi Durable's conversation view (`src/transcript.ts`) as a list of items, and only the items from the first change on are resent. Updates go out at most every 50 ms.
- **The sessions feed** in `src/live.ts` keeps every session's summary current by watching the task graph: a session is running while it has a generation or tool task, and when those end, its summary is read again. A run that ends done or failed triggers a notification once.
- **amyrlin's endpoint** (`src/amyrlin/`) speaks amyrlin's protocol v1. `translate.ts` turns `watchEvents()` into v1 frames; `endpoint.ts` handles commands, the session list and approvals.

- **Settings** (`src/settings.ts`) describe themselves for every client: the HTTP API, the CLI's socket and amyrlin's endpoint all serve the same `Settings`. A change is written to the file and checked as at start, then the host applies what it can (`host.settings.set`). The host reads its workspaces, approval hosts and wait, default model and thinking, and backup schedule from its running settings each time it needs them, so nothing holds a stale copy.

[api.md](api.md) documents all three.

## Changes snapshots

When a project session is created, `src/changes.ts` writes the project's working tree as a git tree through a temporary copy of the index, so untracked files count and ignored ones don't. Only objects are added to the repository; its index, branches and refs are untouched. The tree's hash goes in the session's record. `GET /api/sessions/:id/changes` diffs that tree against a fresh one, limited to the project's directory.

## Search

`src/search.ts` keeps an FTS5 index in `search.sqlite`, a file of its own beside the database, using Node's built-in SQLite, so Pi Durable's schema is never read directly and the index can be rebuilt from scratch. One row per user message or answer: its text (video and restore notes taken out), session, entry, message index, author and time. The host adds rows from `subscribeCommits` as entries land, and at start catches up through each session's `entries()` from the newest entry the index has finished with; that mark only moves after a whole catch-up, since entry IDs are shared by every session. A query becomes quoted terms, the last a prefix, so no input is an FTS5 syntax error. Stemming is the `porter` tokenizer. The first catch-up of about 14,000 entries took a quarter of a second.

## Checkpoints

`src/checkpoints.ts` takes a snapshot of the same kind as each turn starts: a `beforeRequest` hook sees a request whose messages end with a user message, and records a checkpoint keyed by that message's timestamp, once, so a retried or recovered request takes no second one. A steer or follow-up is checkpointed when it reaches the model. A turn's changes are the diff from its checkpoint to the next, or to now for the latest; edits made by hand between turns count in the turn before them.

Restoring is refused while the session runs or waits. It first records the files as they are as a checkpoint of kind `restore`, then lists what differs between the chosen tree and now, writes changed and deleted files back from the tree through a temporary index (`git checkout-index`), and deletes files made since. The real index, branches, commits, ignored files and anything outside the project's directory are left alone. A note goes in `aludra.checkpoints`, and the session's next message carries it as a `<restored>` text block before the user's own text, so the agent knows to read files again.

## Images

Messages may carry PNG, JPEG, GIF or WebP images, at most 8 of at most 5 MB each, checked against their magic bytes. They're stored in the conversation as base64 blocks, and pi-claude-code hands them to Claude Code. Transcripts carry only where each image is (entry, message, block); clients fetch the bytes separately, and cache them for good since stored images never change.

## Files and long messages

`src/files.ts` saves files from clients to `uploads/<session>/`, named for when they came and what they're called, made safe. Each becomes a `<file name="…" type="…" bytes="…" path="…" until="…">` text block after the message's images. `host.submit` moves any text block over 32 KB the same way, as `message.txt`, keeping its first 1,500 characters in the message, so the CLI's `ask` gets it too; a retry, found by its request ID, saves nothing again. The title writer and the search index see messages without file notes. The same hourly sweep as videos deletes them after 14 days.

## Videos

No model takes video, so a video sent from amyrlin (`src/videos.ts`) is written to `uploads/<session>/` in the data directory, and the message carries a text block saying where, `<video name="…" seconds="…" path="…" until="…">`, then the frames amyrlin pulled from it as image blocks. The note tells the agent to pull other frames with ffmpeg. Videos are checked against their magic bytes (an `ftyp` box, or WebM's EBML header) before anything is made or saved. The host deletes uploads 14 days after they arrive, at start and hourly; the frames stay in the conversation. The title writer sees the message without its notes.

## Versions

| Package | Version | Why pinned |
| --- | --- | --- |
| `@earendil-works/pi-durable` and its lockstep packages | 1.3.0 | The provider glue was checked against it. An unpinned install once took pi-codemode 1.2.0, which satisfies 1.1's range and broke 1.1. |
| `@earendil-works/pi-claude-code` | commit `70abb65` (0.1.0) | Not published to npm, so it comes from GitHub at a fixed commit. It moves fast, and loading its source depends on its file layout. |

Every dependency is an exact version. pnpm resolves only versions at least three days old (`minimumReleaseAge` in `pnpm-workspace.yaml`).
