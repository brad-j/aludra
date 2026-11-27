# Development

## Layout

| Path | What |
| --- | --- |
| `src/` | The host and CLI. `main.ts` is the command; [architecture.md](architecture.md) maps the rest. |
| `src/app/` | The app endpoint and its translation to protocol v1 ([protocol.md](protocol.md)). |
| `test/` | Node's test runner, against a faux model and real temporary git repositories. |
| `test/fixtures/` | Recorded Pi Durable streams, their expected protocol v1 frames, and a whole session's frames. |
| `scripts/` | `install.sh`, the live check, the site's terminal picture, and the fixture scripts. |
| `deploy/` | The optional Tailscale node unit for Linux. |
| `spike/` | The scripts that proved pi-claude-bridge, aludra's original Claude provider, in the Pi SDK and in Pi Durable. References, not app code; their paths need adjusting to run again. |
| `docs/` | These docs, [plan.md](plan.md) (open work) and [decisions.md](decisions.md) (decisions and history). |

## Commands

```sh
pnpm install
pnpm check          # tsc, oxlint, then the tests
pnpm test           # the tests only: node --test test/*.test.ts
pnpm lint           # oxlint --deny-warnings
pnpm build          # the host into dist/host, cleared first
pnpm aludra …       # the CLI from source: pnpm aludra doctor
pnpm serve          # the host from source
```

The host runs from source with Node's type stripping (`node --no-warnings src/main.ts`). The installed package runs `dist/host` instead, since Node won't strip types inside `node_modules`.

## Trying it

To try the host without spending anything, run a host with the faux model and a throwaway data directory:

```sh
ALUDRA_MODEL=faux ALUDRA_DATA_DIR=/tmp/aludra-dev pnpm serve
```

The faux model runs a script: any message runs `sleep 4 && pwd`; a message mentioning "markdown" gets a Markdown sample; "write a file for NAME" writes `notes-NAME.md` and edits `NAME.txt`; "plan" writes a `plan` block, runs `sleep 2 && pwd`, then answers with the plan done and a `result` block; "question" answers with a `result` block whose question has three options; "push" runs `git push --dry-run`, which waits for approval. A ship's prompt gets none of the plan or question answers. It's in `fauxModels()` in `src/host.ts`.

To try sandboxes too, add `ALUDRA_SANDBOXES=fake`:

```sh
ALUDRA_MODEL=faux ALUDRA_SANDBOXES=fake ALUDRA_DATA_DIR=/tmp/aludra-dev pnpm serve
```

It replaces the settings' sandbox host with a fake one (`src/fake-sandboxes.ts`, which the tests use too): each sandbox is a git clone of its project's HEAD in `fake-sandboxes/` in the data directory, with no remote, and its tools run through pi-env's local daemon on this machine, so the work comes home as `sandbox/N`, and checks and ship run for real. `host.info` carries `sandboxes` as on a real host, and `afterRun`, `shipTo` and `approvals` still come from the settings. There's no isolation: the agent's tools run as you, here. The host refuses to start with it unless `ALUDRA_MODEL=faux` is set too, so a real model never runs in it.

## Tests

- **Unit and integration** (`test/*.test.ts`): config, projects, setup's guesses, permissions and the protected-path rules, the Claude Code provider's wrapper and loading, the API over HTTP and WebSocket, the app endpoint and translation, changes against real git repositories, images, push encryption and signing, backups, and the CLI. They use the faux model, alone or standing in for Claude Code, and never reach the network.
- **Live** (`scripts/live-check.ts`, by hand): the real pi-claude-code and your Claude Code login. Two sessions at once on the plan's limits, a compaction, and `kill -9` mid tool call with recovery. Run it after upgrading Pi Durable or pi-claude-code. It spends a little of the subscription.

## The protocol fixtures

`test/fixtures/durable-1.1.0/` holds recorded Pi Durable event streams, and `test/fixtures/wire-v1/` their expected protocol v1 frames; `test/app.test.ts` checks that `src/app/translate.ts` turns each into exactly those. After a deliberate change to the translation:

```sh
node --no-warnings scripts/app-export-wire.ts   # rewrites test/fixtures/wire-v1
pnpm test
```

Then copy `wire-v1` into loial's `app/test/fixtures/`. [test/fixtures/README.md](../test/fixtures/README.md) says where they came from.

`scripts/site-images.ts ../aludra-site` makes the site's picture, `aludra sessions` as HTML, from sample sessions and a scripted model. It puts the sample projects in `~/code` for the run and refuses if that exists.

`scripts/app-capture.ts` records a whole session from the endpoint with a faux model into `test/fixtures/server-v1/session.jsonl`, which loial's tests read a copy of.

## Dependencies

- Use pnpm. Add and remove packages with `pnpm add` and `pnpm remove`.
- Every version is exact. pnpm resolves only versions at least three days old (`minimumReleaseAge: 4320` in `pnpm-workspace.yaml`).
- Pi's packages move in lockstep and are pinned together at 1.3.0, with pi-claude-code at a GitHub commit, since it isn't on npm. Upgrading either is deliberate: see [operations.md](operations.md#upgrading-pi-durable-or-pi-claude-code).

## Conventions

- Update these docs when behavior they describe changes: a setting, a command, an endpoint, a permission rule.
- Record decisions, and the reasons for them, in [decisions.md](decisions.md), and open work in [plan.md](plan.md).
- Comments say what code is for and why, in plain sentences. Match the surrounding code.
