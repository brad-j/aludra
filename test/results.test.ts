import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { callChecks, checkSegments, firstParagraph, parsePlan, parseProjectConfig, parseSaid, prose, taskLine, type Turn } from "../src/results.ts";
import { RESULT_INSTRUCTIONS, sandboxSection } from "../src/context.ts";
import { shipPrompt } from "../src/ship.ts";
import { pagesToShoot, routesFromFiles } from "../src/shots.ts";

const answer = [
	"I grouped the packing list by bag.",
	"",
	"```plan",
	"- [x] Read the list",
	"- [x] Group by bag",
	"```",
	"",
	"```result",
	JSON.stringify({
		summary: "The packing list is grouped by bag now.",
		changes: ["Items show under the bag they go in.", ""],
		headsUp: [{ kind: "dependency", text: "Added a small sorting package." }, { kind: "weird", text: "Kept as other." }, "A bare string."],
		question: { text: "Drop the image plugin?", why: "It's unused.", options: ["Drop it", "Keep it"] },
	}),
	"```",
].join("\n");

test("a result block is read from the answer's last one, leniently", () => {
	const said = parseSaid(answer);
	assert.equal(said.summary, "The packing list is grouped by bag now.");
	assert.deepEqual(said.changes, ["Items show under the bag they go in."]);
	assert.deepEqual(said.headsUp, [
		{ kind: "dependency", text: "Added a small sorting package." },
		{ kind: "other", text: "Kept as other." },
		{ kind: "other", text: "A bare string." },
	]);
	assert.deepEqual(said.question, { text: "Drop the image plugin?", why: "It's unused.", options: ["Drop it", "Keep it"] });
	assert.deepEqual(parsePlan(answer), [{ text: "Read the list", done: true }, { text: "Group by bag", done: true }]);
});

test("without a result block, or with a broken one, the summary is the first paragraph", () => {
	assert.deepEqual(parseSaid("**Fixed** the `login` test.\nIt was flaky.\n\nMore detail."), { summary: "Fixed the login test. It was flaky.", changes: [], headsUp: [] });
	assert.equal(parseSaid("Did it.\n\n```result\n{not json\n```").summary, "Did it.");
	assert.equal(parseSaid("```result\n{\"changes\": [\"x\"]}\n```\n").summary, "", "no prose and no summary is empty");
	assert.equal(firstParagraph("```plan\n- [ ] a\n```\n\nRebased.\nSHIP-READY"), "Rebased.");
	assert.equal(prose("Done.\n```result\n{}\n```\nSHIP-BLOCKED: x"), "Done.");
	assert.equal(parsePlan("no plan here"), undefined);
});

test("checks come from the turn's own test and build calls, the last run of each", () => {
	const call = (id: string, command: string): Message => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }], stopReason: "toolUse", timestamp: 1 } as unknown as Message);
	const result = (id: string, isError: boolean, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 2 } as unknown as Message);
	const turn: Turn = { started: 0, messages: [
		call("1", "pnpm test"), result("1", true, "1 failing"),
		call("2", "git log"), result("2", false, ""),
		call("3", "pnpm exec tsc --noEmit"), result("3", false, ""),
		call("4", "pnpm test"), result("4", false, "all pass"),
		call("5", "ls"), result("5", false, ""),
		call("6", "cd /w && printf '## Checks\\nRun the tests and build' >> README.md && git commit -qam 'Checks'"), result("6", false, ""),
	] };
	assert.deepEqual(callChecks(turn), [{ name: "pnpm exec tsc --noEmit", ok: true }, { name: "pnpm test", ok: true }]);
	assert.deepEqual(checkSegments("cd /w && CI=1 pnpm test 2>&1 | tail -20; node --no-warnings --test test/*.ts"), ["pnpm test", "node --no-warnings --test test/*.ts"]);
	assert.deepEqual(checkSegments("echo test && grep build x"), []);
});

test("a project's checks are read from .agents/project.json, as commands or named", () => {
	assert.deepEqual(parseProjectConfig(JSON.stringify({ checks: ["pnpm test", { name: "types", command: "pnpm exec tsc --noEmit" }, { name: "no command" }, 3] })).checks, [
		{ name: "pnpm test", command: "pnpm test" },
		{ name: "types", command: "pnpm exec tsc --noEmit" },
	]);
	assert.deepEqual(parseProjectConfig(undefined), { checks: [], pages: [] });
	assert.deepEqual(parseProjectConfig("{"), { checks: [], pages: [] });
});

test("a project's dev server and pages are read leniently, and pages default to /", () => {
	assert.deepEqual(parseProjectConfig(JSON.stringify({ checks: ["pnpm test"], devServer: { command: "pnpm dev", port: "4380" }, pages: ["/", "settings", { path: "/map", label: "Map" }, { label: "no path" }, "https://x.test/", 4] })), {
		checks: [{ name: "pnpm test", command: "pnpm test" }],
		devServer: { command: "pnpm dev", port: 4380 },
		pages: [{ path: "/" }, { path: "/settings" }, { path: "/map", label: "Map" }],
	});
	assert.deepEqual(parseProjectConfig(JSON.stringify({ devServer: { command: "pnpm dev", port: 3000 } })), { checks: [], devServer: { command: "pnpm dev", port: 3000 }, pages: [{ path: "/" }] });
	// Without a usable dev server, pages mean nothing.
	for (const devServer of [{ command: "pnpm dev" }, { command: "", port: 3000 }, { command: "pnpm dev", port: 70000 }, "pnpm dev"]) {
		assert.deepEqual(parseProjectConfig(JSON.stringify({ devServer, pages: ["/x"] })), { checks: [], pages: [] });
	}
});

test("the pages a turn's changed files make, for file-based routers", () => {
	assert.deepEqual(routesFromFiles([
		"src/routes/index.tsx",
		"src/routes/settings.tsx",
		"src/routes/posts/index.tsx",
		"src/routes/posts.$id.tsx",
		"src/routes/__root.tsx",
		"src/routes/_auth/login.tsx",
		"src/routes/-components/Card.tsx",
		"src/routeTree.gen.ts",
		"src/routes/about.test.tsx",
		"src/routes/flights/map.tsx",
		"src/routes/style.css",
		"src/pages/index.astro",
		"src/pages/blog/first.md",
		"src/pages/_draft.astro",
		"src/pages/[slug].astro",
		"app/(marketing)/pricing/page.tsx",
		"src/routes/account/+page.svelte",
		"src/routes/+layout.svelte",
		"README.md",
	]).sort(), ["/", "/account", "/blog/first", "/flights/map", "/login", "/posts", "/pricing", "/settings"]);
	assert.deepEqual(pagesToShoot([{ path: "/" }, { path: "/map", label: "Map" }], ["/", "/settings", "/a", "/b", "/c", "/d", "/e"]).map((p) => p.path), ["/", "/map", "/settings", "/a", "/b", "/c"]);
});

test("a task's line says the step it's on, what it asks, or how its checks and screenshots went", () => {
	const said = { summary: "Grouped the list by bag. Also tidied.", changes: [], headsUp: [] };
	assert.equal(taskLine({ running: true, plan: [{ text: "Read it", done: true }, { text: "Grouping items by bag", done: false }] }), "Grouping items by bag");
	assert.equal(taskLine({ running: true }), "Working");
	assert.equal(taskLine({ running: false, said: { ...said, question: { text: "Drop the image plugin? It's unused.", options: [] } } }), "Asks: Drop the image plugin?");
	assert.equal(taskLine({ running: false, said, checks: { running: false, checks: [{ name: "a", ok: true }] } }), "Grouped the list by bag. · checks pass");
	assert.equal(taskLine({ running: false, said, checks: { running: false, checks: [{ name: "a", ok: false }] } }), "Grouped the list by bag. · 1 check fails");
	assert.equal(taskLine({ running: false, said, checks: { running: true, checks: [] } }), "Grouped the list by bag. · running checks");
	assert.equal(taskLine({ running: false, said, checks: { running: false, checks: [] }, shooting: true }), "Grouped the list by bag. · taking screenshots");
	assert.equal(taskLine({ running: false }), undefined);
});

test("the sandbox section asks for the plan and result blocks, and the ship prompt for its question", () => {
	const section = sandboxSection({ sandbox: 3, dir: "/home/user/work/one" });
	for (const line of RESULT_INSTRUCTIONS) assert.ok(section.includes(line));
	assert.match(section, /```plan/);
	assert.match(section, /```result/);
	assert.match(shipPrompt("origin/main", "0123456789abcdef"), /SHIP-BLOCKED[\s\S]*result block[\s\S]*options/);
});
