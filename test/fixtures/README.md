# Protocol fixtures

Recorded with the faux model, so no key or network was involved. They came over from the retired macOS client's repository (brad-j/amyrlin, archived) on 2026-11-20, where they were first recorded; aludra keeps them now.

- `durable-1.1.0/`: pi-durable 1.1.0 `watchEvents()` output for 23 scenarios. Its README says how each was produced. [docs/protocol.md](../../docs/protocol.md) cites them by file and line, as `02-tool-round:14`.
- `wire-v1/`: each one translated to protocol v1, one frame's events per line, written by `scripts/app-export-wire.ts`.
- `server-v1/session.jsonl`: one whole session's frames from the endpoint, recorded by `scripts/app-capture.ts`.

`test/app.test.ts` checks that `src/app/translate.ts` turns `durable-1.1.0` into `wire-v1` exactly. loial's tests read copies of `wire-v1` and `server-v1`; copy them again after regenerating either.

The recorder that made `durable-1.1.0` (`scratch/recorder` and its check scripts, named in that README) wasn't brought over: re-recording would be for a new pi-durable version, and would start again from a recorder written for it.
