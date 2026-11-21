// Writes each recorded scenario's protocol v1 translation: every <fixtures>/durable-1.1.0/<name>.jsonl becomes
// <fixtures>/wire-v1/<name>.jsonl, one frame's events per line. test/app.test.ts checks them, and loial's reducer tests
// read a copy.
//   node --no-warnings scripts/app-export-wire.ts [test/fixtures]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { translateFixture } from "../src/app/translate.ts";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "test", "fixtures"));
const source = join(root, "durable-1.1.0");
const target = join(root, "wire-v1");
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter((f) => f.endsWith(".jsonl")).sort()) {
	const frames = translateFixture(readFileSync(join(source, name), "utf8"));
	writeFileSync(join(target, name), frames.map((frame) => JSON.stringify(frame.events)).join("\n") + "\n");
	console.error(`${name}: ${frames.length} frames`);
}
