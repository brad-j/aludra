// Writes each recorded scenario's protocol v1 translation for the amyrlin Mac app's tests: every
// <fixtures>/durable-1.1.0/<name>.jsonl becomes <fixtures>/wire-v1/<name>.jsonl, one frame's events per line.
// amyrlin's ReferenceTranslationTests compares these with its Swift test mapper, so the two translations can't drift.
//   node --no-warnings scripts/amyrlin-export-wire.ts ../amyrlin/fixtures
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { translateFixture } from "../src/amyrlin/translate.ts";

if (!process.argv[2]) throw new Error("usage: amyrlin-export-wire.ts <amyrlin fixtures directory>");
const root = resolve(process.argv[2]);
const source = join(root, "durable-1.1.0");
const target = join(root, "wire-v1");
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter((f) => f.endsWith(".jsonl")).sort()) {
	const frames = translateFixture(readFileSync(join(source, name), "utf8"));
	writeFileSync(join(target, name), frames.map((frame) => JSON.stringify(frame.events)).join("\n") + "\n");
	console.error(`${name}: ${frames.length} frames`);
}
