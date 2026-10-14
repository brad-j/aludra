import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SessionSummary } from "../src/api-types.ts";
import { oklchToRgb, renderSessions } from "../src/listing.ts";

const now = Date.UTC(2026, 9, 13, 12);
const session = (id: number, project: string, state: SessionSummary["state"], minutesAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	workspace: "egwene",
	project,
	dir: `/home/someone/code/${project}`,
	title: `session ${id}`,
	createdAt: now - 86_400_000,
	updatedAt: now - minutesAgo * 60_000,
	state,
	line: `line ${id}`,
	...extra,
});

/** A session's row at width 60: the title on the left, the age against the right edge. */
const row = (mark: string, id: string, title: string, age: string) => {
	const left = `  ${mark} ${id}  ${title}`;
	return `${left}${" ".repeat(60 - left.length - age.length)}${age}`;
};

test("sessions list by project, the one that needs you first, newest first within a project", () => {
	const lines = renderSessions([
		session(7, "gaidin", "done", 120),
		session(28, "gaidin", "done", 5),
		session(62, "aludra", "waiting", 300, { line: "Wants to run git push" }),
		session(82, "aludra", "done", 1),
		session(90, "no project", "running", 0, { dir: "/home/someone/.local/share/aludra/scratch/90" }),
	], {}, { depth: 1, width: 60 }, now);
	assert.deepEqual(lines, [
		"aludra  ~/code/aludra",
		row("◆", "62", "session 62", "5h"),
		"        Wants to run git push",
		row("✓", "82", "session 82", "1m"),
		"        line 82",
		"",
		"no project  scratch",
		row("◐", "90", "session 90", "now"),
		"        line 90",
		"",
		"gaidin  ~/code/gaidin",
		row("✓", "28", "session 28", "5m"),
		"        line 28",
		row("✓", " 7", "session 7", "2h"),
		"        line 7",
	]);
	assert.ok(lines.every((line) => line.length <= 60));
});

test("long titles and lines are cut to the width; ages stay at the right edge", () => {
	const lines = renderSessions([session(1, "a", "done", 0, { title: "x".repeat(200), line: "y".repeat(200) })], {}, { depth: 1, width: 50 }, now);
	assert.equal(lines[1]!.length, 50);
	assert.match(lines[1]!, /x…  now$/);
	assert.match(lines[2]!, /y…$/);
	assert.equal(lines[2]!.length, 50);
});

test("colors follow the terminal: none when plain, the project's hue and the state's ink when not", () => {
	const sessions = [session(1, "aludra", "failed", 3), session(2, "amyrlin", "done", 4)];
	const plain = renderSessions(sessions, {}, { depth: 1, width: 80 }, now);
	assert.ok(plain.every((line) => !line.includes("\x1b")));
	assert.ok(renderSessions([session(3, "a", "done", 0, { title: "z".repeat(200) })], {}, { depth: 1, width: 50 }, now).every((line) => !line.includes("\x1b")), "nor when cut");

	const truecolor = renderSessions(sessions, {}, { depth: 24, width: 80 }, now);
	assert.deepEqual(truecolor.map(stripTerminalSequences), plain, "the same text under the color");
	// amyrlin's hue is 300, the accent violet the Mac app gives it; failed is the app's red.
	assert.ok(truecolor.some((line) => line.includes(`38;2;${oklchToRgb([0.8, 0.12, 300]).join(";")}m`)));
	assert.ok(truecolor.some((line) => line.includes(`\x1b[38;2;${oklchToRgb([0.72, 0.15, 22]).join(";")}m⊘`)));
	// A picked hue wins over the name's.
	assert.ok(renderSessions(sessions, { aludra: 1 }, { depth: 24, width: 80 }, now).some((line) => line.includes(`38;2;${oklchToRgb([0.8, 0.12, 165]).join(";")}m`)));

	assert.ok(renderSessions(sessions, {}, { depth: 8, width: 80 }, now).some((line) => line.includes("\x1b[1;38;5;")));
	assert.ok(renderSessions(sessions, {}, { depth: 4, width: 80 }, now).some((line) => line.includes("\x1b[31m⊘")));
});

test("archived sessions are left out of the list, with a count at the foot", () => {
	const lines = renderSessions([session(1, "a", "done", 0), session(2, "a", "done", 0, { archived: true }), session(3, "b", "done", 0, { archived: true })], {}, { depth: 1, width: 60 }, now);
	assert.equal(lines.some((l) => /session [23]/.test(l)), false);
	assert.match(lines.at(-1)!, /^2 archived; aludra unarchive --session ID/);
	assert.match(renderSessions([session(2, "a", "done", 0, { archived: true })], {}, { depth: 1, width: 60 }, now)[0]!, /every session is archived/);
});

test("OKLCH converts to sRGB as CSS does", () => {
	assert.deepEqual(oklchToRgb([1, 0, 0]), [255, 255, 255]);
	assert.deepEqual(oklchToRgb([0, 0, 0]), [0, 0, 0]);
	// oklch(62.8% 0.2577 29.23) is CSS red.
	assert.deepEqual(oklchToRgb([0.628, 0.2577, 29.23]), [255, 0, 0]);
});
