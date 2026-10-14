# Development

## Layout

| Path | What |
| --- | --- |
| `src/` | The host and CLI. `main.ts` is the command; [architecture.md](architecture.md) maps the rest. |
| `src/amyrlin/` | amyrlin's endpoint and its translation to protocol v1. |
| `app/` | The web app (TanStack Start, SPA mode). |
| `test/` | Node's test runner, against a faux model and real temporary git repositories. |
| `test/fixtures/amyrlin/` | amyrlin's recorded Pi Durable streams and their expected protocol v1 frames. |
| `e2e/` | Playwright against the built app and a faux host. |
| `scripts/` | `install.sh`, the live check, and the amyrlin fixture scripts. |
| `design/` | The approved prototype (`prototype.html`) and its tokens. |
| `deploy/` | The optional Tailscale node unit for Linux. |
| `spike/` | The scripts that first proved the bridge in the Pi SDK and in Pi Durable. References, not app code; their paths need adjusting to run again. |
| `docs/` | These docs, [plan.md](plan.md) (decisions and history), and the design brief. |

## Commands

```sh
pnpm install
pnpm check          # tsc for the host and the app, oxlint, then the tests
pnpm test           # the tests only: node --test test/*.test.ts
pnpm lint           # oxlint --deny-warnings
pnpm build          # the app into dist/client, the host into dist/host
pnpm e2e            # build, then Playwright
pnpm dev            # the app on Vite at 127.0.0.1:8725, against a running host
pnpm aludra …       # the CLI from source: pnpm aludra doctor
pnpm serve          # the host from source
```

The host runs from source with Node's type stripping (`node --no-warnings src/main.ts`). The installed package runs `dist/host` instead, since Node won't strip types inside `node_modules`.

## Working on the app

`pnpm dev` runs Vite on `127.0.0.1:8725` and proxies `/api` (including the WebSocket) to the host on `api.port`, adding the first login in `api.users` as the Tailscale header. Run a host beside it, either the installed service or `pnpm serve`. Vite's reloads never touch the host, so running sessions carry on.

To try the app without spending anything, run a host with the faux model and a throwaway data directory:

```sh
ALUDRA_MODEL=faux ALUDRA_DATA_DIR=/tmp/aludra-dev pnpm serve
```

The faux model runs a script: any message runs `sleep 4 && pwd`; a message mentioning "markdown" gets a Markdown sample; "write a file for NAME" writes `notes-NAME.md` and edits `NAME.txt`; "push" runs `git push --dry-run`, which waits for approval. It's in `fauxModels()` in `src/host.ts`.

The app follows the approved design in `design/prototype.html` and `design/tokens.css`, with the later changes [plan.md](plan.md) records (the Console layer, the wide layout, amyrlin's look). Check new UI at phone size and at desktop width; the e2e overflow check covers 320 to 1280 px.

## Tests

- **Unit and integration** (`test/*.test.ts`): config, projects, setup's guesses, permissions and the protected-path rules, the bridge fixes (each test fails without its fix), the API over HTTP and WebSocket, amyrlin's endpoint and translation, changes against real git repositories, images, push encryption and signing, backups, and the CLI. They use the faux model or a fake bridge and never reach the network.
- **End to end** (`pnpm e2e`): `e2e/setup.ts` makes a scratch git project and a project outside git, then Playwright starts a faux host from `e2e/aludra.json` on port 8726 with fresh data in `e2e/results/`, and runs `e2e/app.spec.ts` at iPhone size (Chromium with touch) and at 1280 × 800. WebKit isn't used, since it needs system libraries some machines lack; a real iOS device is the Safari check.
- **Live** (`scripts/live-check.ts`, by hand): the real bridge and your Claude Code login. Two sessions at once, a compaction, and `kill -9` mid tool call with recovery. Run it after upgrading Pi Durable or the bridge. It spends a little of the subscription.

## The amyrlin fixtures

amyrlin records Pi Durable event streams and keeps them in its `fixtures/`. aludra keeps a copy and checks that `src/amyrlin/translate.ts` turns each into exactly the expected frames. After amyrlin re-records, from an aludra checkout with amyrlin's beside it:

```sh
cp -R ../amyrlin/fixtures/durable-1.1.0 test/fixtures/amyrlin/
node --no-warnings scripts/amyrlin-export-wire.ts ../amyrlin/fixtures   # writes amyrlin's fixtures/wire-v1
cp -R ../amyrlin/fixtures/wire-v1 test/fixtures/amyrlin/
pnpm test
```

`scripts/site-images.ts ../aludra-site` makes the site's two pictures, the web app on a phone and a frame of the terminal UI, from sample sessions and a scripted model (run `pnpm build` first). It puts the sample projects in `~/code` for the run and refuses if that exists.

`scripts/amyrlin-capture.ts ../amyrlin/fixtures/server-v1/session.jsonl` records a whole session from the endpoint with a faux model, for amyrlin's own server test.

## Dependencies

- Use pnpm. Add and remove packages with `pnpm add` and `pnpm remove`.
- Every version is exact. pnpm resolves only versions at least three days old (`minimumReleaseAge: 4320` in `pnpm-workspace.yaml`).
- Pi's packages move in lockstep and are pinned together at 1.1.0, with pi-claude-bridge at 0.9.2. Upgrading either is deliberate: see [operations.md](operations.md#upgrading-pi-durable-or-the-bridge).
- React, TanStack, Vite and the fonts are dev dependencies: the package ships the built app, not its sources.

## Conventions

- Update these docs when behavior they describe changes: a setting, a command, an endpoint, a permission rule.
- Record decisions, and the reasons for them, in [plan.md](plan.md).
- Comments say what code is for and why, in plain sentences. Match the surrounding code.
