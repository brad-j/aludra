# amyrlin fixtures

Copied from [brad-j/amyrlin](https://github.com/brad-j/amyrlin) `fixtures/`, where they're recorded and documented.

- `durable-1.1.0/`: pi-durable 1.1.0 `watchEvents()` output for 18 scenarios, recorded with the faux model.
- `wire-v1/`: each one translated to protocol v1, one frame per line, written by `scripts/amyrlin-export-wire.ts`.

`test/amyrlin.test.ts` checks that `src/amyrlin/translate.ts` turns the first into the second exactly. Copy both again
after re-recording in amyrlin.
