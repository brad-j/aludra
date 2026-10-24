# Development

## Layout

| Path | What |
| --- | --- |
| `src/` | The host and CLI. `main.ts` is the command; [architecture.md](architecture.md) maps the rest. |
| `src/amyrlin/` | amyrlin's endpoint and its translation to protocol v1. |
| `test/` | Node's test runner, against a faux model and real temporary git repositories. |
| `test/fixtures/amyrlin/` | amyrlin's recorded Pi Durable streams and their expected protocol v1 frames. |
| `scripts/` | `install.sh`, the live check, the site's terminal picture, and the amyrlin fixture scripts. |
| `deploy/` | The optional Tailscale node unit for Linux. |
| `spike/` | The scripts that first proved the bridge in the Pi SDK and in Pi Durable. References, not app code; their paths need adjusting to run again. |
| `docs/` | These docs and [plan.md](plan.md) (decisions and history). |

## Commands

```sh
pnpm install
pnpm check          # tsc, oxlint, then the tests
pnpm test           # the tests only: node --test test/*.test.ts
pnpm lint           # oxlint --deny-warnings
pnpm build          # the host into dist/host
pnpm aludra …       # the CLI from source: pnpm aludra doctor
pnpm serve          # the host from source
```

The host runs from source with Node's type stripping (`node --no-warnings src/main.ts`). The installed package runs `dist/host` instead, since Node won't strip types inside `node_modules`.

## Trying it

To try the host without spending anything, run a host with the faux model and a throwaway data directory:

```sh
ALUDRA_MODEL=faux ALUDRA_DATA_DIR=/tmp/aludra-dev pnpm serve
```

The faux model runs a script: any message runs `sleep 4 && pwd`; a message mentioning "markdown" gets a Markdown sample; "write a file for NAME" writes `notes-NAME.md` and edits `NAME.txt`; "push" runs `git push --dry-run`, which waits for approval. It's in `fauxModels()` in `src/host.ts`.

## Tests

- **Unit and integration** (`test/*.test.ts`): config, projects, setup's guesses, permissions and the protected-path rules, the bridge fixes (each test fails without its fix), the API over HTTP and WebSocket, amyrlin's endpoint and translation, changes against real git repositories, images, push encryption and signing, backups, and the CLI. They use the faux model or a fake bridge and never reach the network.
- **Live** (`scripts/live-check.ts`, by hand): the real bridge and your Claude Code login. Two sessions at once, a compaction, and `kill -9` mid tool call with recovery. Run it after upgrading Pi Durable or the bridge. It spends a little of the subscription.

## The amyrlin fixtures

amyrlin records Pi Durable event streams and keeps them in its `fixtures/`. aludra keeps a copy and checks that `src/amyrlin/translate.ts` turns each into exactly the expected frames. After amyrlin re-records, from an aludra checkout with amyrlin's beside it:

```sh
cp -R ../amyrlin/fixtures/durable-1.1.0 test/fixtures/amyrlin/
node --no-warnings scripts/amyrlin-export-wire.ts ../amyrlin/fixtures   # writes amyrlin's fixtures/wire-v1
cp -R ../amyrlin/fixtures/wire-v1 test/fixtures/amyrlin/
pnpm test
```

`scripts/site-images.ts ../aludra-site` makes the site's picture, a frame of the terminal UI, from sample sessions and a scripted model. It puts the sample projects in `~/code` for the run and refuses if that exists.

`scripts/amyrlin-capture.ts ../amyrlin/fixtures/server-v1/session.jsonl` records a whole session from the endpoint with a faux model, for amyrlin's own server test.

## Dependencies

- Use pnpm. Add and remove packages with `pnpm add` and `pnpm remove`.
- Every version is exact. pnpm resolves only versions at least three days old (`minimumReleaseAge: 4320` in `pnpm-workspace.yaml`).
- Pi's packages move in lockstep and are pinned together at 1.3.0, with pi-claude-bridge at 0.9.3. Upgrading either is deliberate: see [operations.md](operations.md#upgrading-pi-durable-or-the-bridge).

## Conventions

- Update these docs when behavior they describe changes: a setting, a command, an endpoint, a permission rule.
- Record decisions, and the reasons for them, in [plan.md](plan.md).
- Comments say what code is for and why, in plain sentences. Match the surrounding code.
