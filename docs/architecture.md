# Architecture

How aludra works today. [plan.md](plan.md) has the history: what was decided, when, and why.

## The pieces

```
 browser (phone or computer)   amyrlin (macOS)             terminal
        │ HTTPS + WS /api/live        │ WSS /amyrlin             │
        └──────────────┬──────────────┘                          │
               tailscale serve  (adds Tailscale-User-Login)      │
                       │                                         │
               127.0.0.1:8724                          aludra.sock (Unix socket)
                       │                                         │
 ┌─────────────────────┴─────────────── aludra serve ────────────┴──────┐
 │  src/api.ts  ── web API, the built app, the /amyrlin endpoint         │
 │  src/server.ts ── the CLI's socket                                    │
 │  src/live.ts ── the live feed both sockets share                      │
 │  src/host.ts ── Pi Durable Harness over aludra.sqlite                 │
 │     extensions: CodingTools · project context · bridge · permissions  │
 │  src/bridge.ts ── pi-claude-bridge as a pi-ai provider                │
 └───────────────────────────────┬───────────────────────────────────────┘
                                 │ Agent SDK
                       Claude Code (claude.path), the user's own login
```

One long-lived Node process, `aludra serve`, owns the SQLite file and runs every session. The apps and the CLI are clients; none of them hold state that matters. Because the host is separate from the app's build, rebuilding or reloading the app never touches running work.

## The host

`src/host.ts` opens a Pi Durable 1.1.0 `Harness` over `aludra.sqlite` in the data directory and calls `harness.resume()` at start, which continues whatever the last process left unfinished.

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

- **Extensions**, installed in this order:
  1. Pi Durable's `CodingTools`: `read`, `write`, `edit` and `bash`, each run in a `NodeExecutionEnv` from the conversation's `cwd`.
  2. Project context (`src/context.ts`): `AGENTS.md` or `CLAUDE.md` and skills, found with pi-coding-agent's own loaders the way the pi coding agent finds them, and read again before every request. A no-project session gets a `no_project` section instead, saying where things are on the machine.
  3. The bridge's extension (`src/bridge.ts`), which records each conversation's `cwd` and system prompt for the provider.
  4. Permissions (`src/permissions.ts`), last, so it wraps every tool the others bring.

## Model providers

Pi Durable gets one pi-ai `Models` collection: the bridge when `model.choices` names a Claude model, and pi-ai's own `openai` and `openrouter` providers always, with a credential store over `credentials.json` in the data directory (`src/credentials.ts`). Sessions can change provider between requests: the bridge rebuilds Claude Code's session from the transcript when it finds messages it didn't see.

- **OpenAI** is pi-ai's own `openai` provider, which Pi Durable drives directly, with nothing in between. `aludra login openai` (`src/login.ts`) runs pi-ai's Sign in with ChatGPT flow with the machine's installation ID, and the store keeps and refreshes the tokens. The store reads the file for every request, so a login from the CLI reaches a running host; a lock file keeps the CLI and the host from writing at once.
- **OpenRouter** is pi-ai's `openrouter` provider and its catalog of several hundred priced models. `aludra login openrouter` runs pi-ai's OAuth flow, which leaves an API key in the store.
- **Claude** goes through the bridge, below.

`src/catalog.ts` lists every model a session can run on: each provider this machine is signed in to, OpenAI's narrowed to what the ChatGPT account offers (asked of the account hourly). The pickers search it; `model.choices` are pinned above it. Costs come from pi-ai, which prices each answer from the catalog; A session's `cost` is `billedCost` in `src/transcript.ts`: the OpenRouter part of its usage ledger (Pi Durable's `pi.usage`, keyed `provider/modelId`), which counts compaction summaries too. The month's total is `spendOf`, which adds up answers by their time; the ledger has no times, so that total leaves out compaction summaries.

### The bridge

`src/bridge.ts` loads [pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge) 0.9.2, a pi extension that drives Claude Code through the Agent SDK. The bridge was written for the pi coding agent's loop, so it loads through jiti with a stand-in for pi's `ExtensionAPI` that keeps its provider and event handlers. Its `streamSimple` is wrapped with five fixes Pi Durable needs:

- **Signals.** Pi Durable aborts each request's signal when that request is done; the bridge ties one long-lived Claude Code query to the first. The wrapper keeps one controller per session and forwards an abort only while a stream runs.
- **Restarts.** After a restart the bridge has no live query, and a transcript ending in a tool result would end the turn empty. The wrapper adds a short note to that one request, which sends the bridge down its rebuild path.
- **Compaction and reset.** These replace the head of the history. The wrapper notices and calls the bridge's own `session_compact` handler so it rebuilds Claude Code's session from the summary.
- **The system prompt.** Each request's prompt is recorded with the bridge as a custom prompt, so Claude Code gets all of it after its own preset.
- **The working directory.** The bridge runs Claude Code in `process.cwd()`. The wrapper changes into the conversation's directory around the call, so Claude Code's session files land per project and show in `claude --resume` there.

The bridge runs the user's own Claude Code (`claude.path`), not the Agent SDK's bundled copy. It reads that path only from its settings in pi's agent directory, so aludra gives it a directory of its own (`bridge/` in the data directory) by aliasing its pi-coding-agent import to a module there whose `getAgentDir()` answers with it.

These fixes depend on bridge internals, so the bridge and Pi Durable are pinned and `aludra doctor` fails if either changes. `test/bridge.test.ts` has a test for each fix, and `scripts/live-check.ts` runs them against the real thing ([operations.md](operations.md#upgrading-pi-durable-or-the-bridge)).

## Titles

`src/titles.ts` writes each session's title from its first message once it's submitted, in the background: a one-off request (`cacheRetention: "none"`, which the bridge runs as its own Claude Code process with no tools and no saved session) to the smallest model on hand, then the next if one fails. The host records who wrote a title, so a rename by hand is never replaced, and announces the change like a rename. The faux model writes none.

## Permissions

A `beforeTool` hook asks for approval: it opens a request in `aludra.approvals` keyed by a memoized ID, so a restart waits on the same request, and waits for a decision, an expiry, a stop, or a new message from the user. The protected-path gate wraps `read`, `write`, `edit` and `bash` instead of using a hook, because ending the run on the second block needs a tool result with `control.terminate`, which a hook can't return. [security.md](security.md#permissions) has the rules.

## Clients

- **The CLI** (`src/cli.ts`, `src/server.ts`) sends one JSON request per connection over `aludra.sock` and prints the lines that come back. Live output comes from Pi Durable's `watchEvents()`. `aludra sessions` gets the drawer's session summaries as data instead and lays them out for the terminal (`src/listing.ts`), with pi-tui's width handling.
- **The terminal UI** (`src/tui.ts`, `aludra` with no command) keeps a `live` connection open on the same socket and gets the web app's live events. It's built with pi-tui, terminal pi's own library: an alternate-screen layout of a session tree, a header and a scrolling transcript, with pi-tui's Markdown for answers.
- **The web app's API** (`src/api.ts`) serves HTTP for actions and one WebSocket, `/api/live`, for everything live, from the feed in `src/live.ts` that the terminal UI shares. A followed session's transcript is built from Pi Durable's conversation view (`src/transcript.ts`) as a list of items, and only the items from the first change on are resent. Updates go out at most every 50 ms.
- **The sessions feed** in `src/live.ts` keeps every session's summary current by watching the task graph: a session is running while it has a generation or tool task, and when those end, its summary is read again. A run that ends done or failed triggers a notification once.
- **amyrlin's endpoint** (`src/amyrlin/`) speaks amyrlin's protocol v1. `translate.ts` turns `watchEvents()` into v1 frames; `endpoint.ts` handles commands, the session list and approvals.

[api.md](api.md) documents all three.

## The app

`app/` is a TanStack Start app built in SPA mode: the UI is all client-side over the WebSocket, so there's no server rendering and no second process. `pnpm build` writes `dist/client`, which the host serves and reads at start. It's an installable PWA: a manifest, a service worker (`app/public/sw.js`) that shows notifications and an offline page, and Web Push.

| Path | What |
| --- | --- |
| `app/routes/` | `/` (new session), `/s/:id` (a session), `/s/:id/changes`. |
| `app/components/` | The shell and drawer, the session screen, the composer, pickers, ideas, the changes view. |
| `app/lib/live.ts` | The WebSocket and the app's state. |
| `app/lib/projects.ts` | Project colors (from `src/project-colors.ts`: an FNV hash into eleven OKLCH hues, shared with amyrlin and the CLI) and the project picker's ordering. |
| `app/lib/images.ts` | Scaling and re-encoding attached images. |
| `app/lib/markdown.ts` | A DOM-building Markdown renderer, so no model text goes through `innerHTML`. |
| `app/styles/app.css` | All styles. The "Console" layer at the end is the current look. |
| `design/` | The approved prototype and its tokens. |

## Changes snapshots

When a project session is created, `src/changes.ts` writes the project's working tree as a git tree through a temporary copy of the index, so untracked files count and ignored ones don't. Only objects are added to the repository; its index, branches and refs are untouched. The tree's hash goes in the session's record. The changes view diffs that tree against a fresh one, limited to the project's directory.

## Images

Messages may carry PNG, JPEG, GIF or WebP images, at most 8 of at most 5 MB each, checked against their magic bytes. They're stored in the conversation as base64 blocks, and the bridge hands them to Claude Code. Transcripts carry only where each image is (entry, message, block); the apps fetch the bytes separately, and cache them for good since stored images never change.

## Versions

| Package | Version | Why pinned |
| --- | --- | --- |
| `@earendil-works/pi-durable` and its lockstep packages | 1.1.0 | The bridge glue was checked against it. An unpinned install once took pi-codemode 1.2.0, which satisfies 1.1's range and breaks it. |
| `pi-claude-bridge` | 0.9.2 | The glue depends on its internals. |

Every dependency is an exact version. pnpm resolves only versions at least three days old (`minimumReleaseAge` in `pnpm-workspace.yaml`).
