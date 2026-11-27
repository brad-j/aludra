// The ideas tools (src/ideas.ts) against a local bare repository, called directly; which sessions get them; and
// /app's Ideas methods end to end with the faux model. Brought over from Pi Desktop's pi-host.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import type { Json } from "../src/app/translate.ts";
import { IdeasRepo, readSnapshot } from "../src/ideas-repo.ts";
import { appendLog, createIdeasOps, createIdeasTools, ideaChatSection, type IdeaToolDetails, saveToIdeaMessage, setFields, setSection, slug } from "../src/ideas.ts";
import { fakeGh, tempDir, testHost } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "aludra-ideas-tools-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) process.env[k] = "t";
for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) process.env[k] = "t@t";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const IDEA = `---
id: 6
title: Agent quick-capture (Mac)
status: raw
areas: [software]
created: 2026-10-16
updated: 2026-10-16
related: []
project:
summary: Floating hotkey window
chats: []
---

# Agent quick-capture (Mac)

## The idea

A small floating window.

## Why

## Open questions

- Is the list for the user or for agents?

## Next steps

## Log

- 2026-10-16: captured, quick idea.
`;
const INBOX = "# Inbox\n\nQuick captures.\n\n- #2 2026-08-20: Message board for the boy. Intercom?\n";
const INDEX = "# Index\n\nNext ID: **15**\n";

let n = 0;
/** A bare "GitHub" with the ideas files, and a clone of it. */
function setup(base = join(scratch, String(++n))) {
	const origin = join(base, "origin.git");
	const seed = join(base, "seed");
	mkdirSync(join(seed, "ideas"), { recursive: true });
	git(base, "init", "-q", "--bare", "-b", "master", origin);
	git(seed, "init", "-q", "-b", "master");
	writeFileSync(join(seed, "ideas", "2026-10-16-agent-quick-capture.md"), IDEA);
	writeFileSync(join(seed, "inbox.md"), INBOX);
	writeFileSync(join(seed, "INDEX.md"), INDEX);
	git(seed, "add", "-A");
	git(seed, "commit", "-q", "-m", "seed");
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "-q", "-u", "origin", "master");
	const clone = join(base, "clone");
	git(base, "clone", "-q", origin, clone);
	return clone;
}

type AnyTool = { name: string; execute: (args: never, api: never, context: never) => Promise<{ isError?: boolean; output: { text: string }[]; details?: unknown }> };
/** The tools on `clone`. Pass the test's own repo when it also calls one directly, so two don't sync past each other. */
function toolsFor(clone: string, repo = new IdeasRepo(clone)) {
	const list = createIdeasTools({ repo: () => repo, today: () => "2026-11-19", sessionIdea: async () => undefined, sessionRef: (id) => `test-host/${id}` }) as unknown as AnyTool[];
	const byName = Object.fromEntries(list.map((t) => [t.name, t]));
	return async (name: string, args: object, conversationId = 3) => {
		const r = await byName[name]!.execute(args as never, { conversationId } as never, BACKGROUND_CONTEXT as never);
		return { ...r, text: r.output.map((o) => o.text).join("") };
	};
}

describe("editing helpers", () => {
	test("setFields keeps order and adds new fields", () => {
		const out = setFields(IDEA, { status: "doing", project: "brad-j/x", extra: "1" });
		assert.match(out, /status: doing\nareas: \[software\]/);
		assert.match(out, /project: brad-j\/x\nsummary:/);
		assert.match(out, /chats: \[\]\nextra: 1\n---/);
	});

	test("setSection replaces one section and adds missing ones before Log", () => {
		const body = IDEA.split("---\n")[2]!;
		const out = setSection(body, "Why", "Because.");
		assert.match(out, /## Why\n\nBecause.\n\n## Open questions/);
		const added = setSection(body, "Prior art", "- Raycast");
		assert.match(added, /## Next steps\n\n## Prior art\n\n- Raycast\n\n## Log/);
	});

	test("appendLog adds to the end of Log", () => {
		const body = IDEA.split("---\n")[2]!;
		assert.match(appendLog(body, "- 2026-11-19: x"), /- 2026-10-16: captured, quick idea.\n- 2026-11-19: x\n$/);
		assert.match(appendLog("# T\n", "- d: x"), /# T\n\n## Log\n\n- d: x\n$/);
	});

	test("a session about an idea is told what Save to idea asks for", async () => {
		const repo = new IdeasRepo(setup());
		const onFile = (await ideaChatSection(repo, 6))!;
		assert.match(onFile, /When the user sends "Save this chat to idea #6\.", fold everything this session settled into the file with one update_idea call/);
		assert.match(onFile, /not a transcript/);
		assert.match(onFile, /If nothing new was settled, say so and change nothing\./);
		const onCapture = (await ideaChatSection(repo, 2))!;
		assert.match(onCapture, /"Save this chat to idea #2\."/);
		assert.match(onCapture, /that call promotes it, so give it a title, a summary and its areas too\./);
	});

	test("slug", () => {
		assert.equal(slug("Widget / app / extension factory"), "widget-app-extension-factory");
		assert.equal(slug("!!!"), "idea");
	});
});

describe("the tools", () => {
	test("list_ideas and read_idea", async () => {
		const call = toolsFor(setup());
		const all = await call("list_ideas", {});
		assert.match(all.text, /#6 \[raw\] Agent quick-capture \(Mac\) \(software\): Floating hotkey window/);
		assert.match(all.text, /#2 \[capture 2026-08-20\] Message board/);
		assert.doesNotMatch((await call("list_ideas", { status: "raw" })).text, /#2/);
		assert.equal((await call("list_ideas", { query: "intercom" })).text.split("\n").length, 1);
		assert.match((await call("read_idea", { id: 6 })).text, /^ideas\/2026-10-16-agent-quick-capture.md\n\n---\nid: 6/);
		assert.match((await call("read_idea", { id: 2 })).text, /inbox capture from 2026-08-20/);
		assert.equal((await call("read_idea", { id: 99 })).isError, true);
	});

	test("capture takes the next ID and commits", async () => {
		const clone = setup();
		const call = toolsFor(clone);
		const r = await call("capture", { text: "  A thought\nover two lines " });
		assert.match(r.text, /^Captured #15 in the inbox/);
		assert.match(readFileSync(join(clone, "inbox.md"), "utf8"), /- #15 2026-11-19: A thought over two lines\n$/);
		assert.equal(git(clone, "log", "-1", "--format=%s").trim(), "#15: capture");
		await new IdeasRepo(clone).sync();
		assert.equal((r.details as IdeaToolDetails).commit, git(clone, "rev-parse", "origin/master").trim());
		assert.match(readFileSync(join(clone, "INDEX.md"), "utf8"), /Next ID: \*\*16\*\*/);
	});

	test("save_idea writes a file in the template's shape, linked to the session", async () => {
		const clone = setup();
		const call = toolsFor(clone);
		const r = await call("save_idea", { title: "Bird feeder cam", summary: "A camera on the feeder", areas: ["electronics", "electronics"], idea: "Watch birds.", open_questions: ["Which camera?"], next_steps: [] }, 12);
		const d = r.details as IdeaToolDetails;
		assert.equal(d.id, 15);
		assert.equal(d.path, "ideas/2026-11-19-bird-feeder-cam.md");
		const file = readFileSync(join(clone, d.path), "utf8");
		assert.match(file, /^---\nid: 15\ntitle: Bird feeder cam\nstatus: raw\nareas: \[electronics\]\ncreated: 2026-11-19\nupdated: 2026-11-19\nrelated: \[\]\nproject:\nsummary: A camera on the feeder\nsessions: \[test-host\/12\]\n---\n/);
		assert.match(file, /## The idea\n\nWatch birds.\n\n## Why\n\n## Open questions\n\n- Which camera\?\n\n## Next steps\n\n## Log\n\n- 2026-11-19: Saved from a session.\n$/);
		const snap = await readSnapshot(clone);
		assert.deepEqual(snap.ideas.find((i) => i.id === 15)?.sessions, ["test-host/12"]);
		assert.match(readFileSync(join(clone, "INDEX.md"), "utf8"), /\| 15 \| \[Bird feeder cam\]\(ideas\/2026-11-19-bird-feeder-cam.md\) \| raw \| electronics \| A camera on the feeder \|/);
		// The same title again gets its own file.
		const again = await call("save_idea", { title: "Bird feeder cam", summary: "s", areas: [], idea: "i" });
		assert.equal((again.details as IdeaToolDetails).path, "ideas/2026-11-19-bird-feeder-cam-16.md");
	});

	test("update_idea changes fields, sections and the Log", async () => {
		const clone = setup();
		const call = toolsFor(clone);
		const r = await call("update_idea", {
			id: 6,
			title: "Quick capture",
			summary: "Hotkey notes",
			sections: [{ name: "Why", text: "Thoughts get lost." }, { name: "Prior art", text: "- Raycast" }],
			log: "Added why.",
		});
		assert.match(r.text, /Updated #6 \(title, summary, Why, Prior art, Log\)/);
		const file = readFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), "utf8");
		assert.match(file, /title: Quick capture\n/);
		assert.match(file, /updated: 2026-11-19\n/);
		assert.match(file, /summary: Hotkey notes\n/);
		assert.match(file, /\n# Quick capture\n/);
		assert.match(file, /## Why\n\nThoughts get lost.\n\n## Open questions\n\n- Is the list/);
		assert.match(file, /## Prior art\n\n- Raycast\n\n## Log/);
		assert.match(file, /- 2026-11-19: Added why.\n$/);
		assert.equal(git(clone, "log", "-1", "--format=%s").trim(), "#6: update title, summary, Why, Prior art, Log");
		assert.equal((await call("update_idea", { id: 6, sections: [{ name: "Log", text: "x" }] })).isError, true);
	});

	test("update_idea promotes a capture with the same ID", async () => {
		const clone = setup();
		const call = toolsFor(clone);
		assert.match((await call("update_idea", { id: 2 })).text, /give a title/);
		const r = await call("update_idea", { id: 2, title: "Intercom for the boy", areas: ["electronics"] });
		const d = r.details as IdeaToolDetails;
		assert.equal(d.path, "ideas/2026-08-20-intercom-for-the-boy.md");
		assert.doesNotMatch(readFileSync(join(clone, "inbox.md"), "utf8"), /#2 /);
		const file = readFileSync(join(clone, d.path), "utf8");
		assert.match(file, /id: 2\n/);
		assert.match(file, /areas: \[electronics\]/);
		assert.match(file, /created: 2026-08-20/);
		assert.match(file, /- 2026-08-20: Captured in the inbox.\n- 2026-11-19: Promoted to a file.\n$/);
		assert.equal((await readSnapshot(clone)).nextId, 15);
	});

	test("set_status logs the change; captures and unknown IDs are refused", async () => {
		const clone = setup();
		const call = toolsFor(clone);
		await call("set_status", { id: 6, status: "doing", project: "brad-j/quick-capture", reason: "Building it." });
		const file = readFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), "utf8");
		assert.match(file, /status: doing\n/);
		assert.match(file, /project: brad-j\/quick-capture\n/);
		assert.match(file, /- 2026-11-19: Status raw → doing: Building it.\n$/);
		assert.match((await call("set_status", { id: 2, status: "parked" })).text, /promote it with update_idea first/);
		assert.match((await call("set_status", { id: 99, status: "parked" })).text, /No idea #99/);
		// A refused write leaves nothing behind.
		assert.equal(git(clone, "status", "--porcelain"), "");
	});

	test("save_idea works in a repository with no ideas/ yet", async () => {
		const clone = setup();
		git(clone, "rm", "-q", "-r", "ideas");
		git(clone, "commit", "-q", "-m", "empty");
		git(clone, "push", "-q");
		const r = await toolsFor(clone)("save_idea", { title: "First", summary: "s", areas: [], idea: "i" });
		assert.equal(r.isError, undefined);
		assert.equal((r.details as IdeaToolDetails).path, "ideas/2026-11-19-first.md");
	});

	test("a write carries its diff without INDEX.md, and undo keeps the ID retired", async () => {
		const clone = setup();
		const repo = new IdeasRepo(clone);
		const call = toolsFor(clone, repo);
		const r = await call("capture", { text: "Undo me" });
		const d = r.details as IdeaToolDetails;
		assert.match(d.diff!, /^diff --git a\/inbox.md b\/inbox.md/);
		assert.match(d.diff!, /\n\+- #15 2026-11-19: Undo me\n/);
		assert.doesNotMatch(d.diff!, /INDEX.md/);
		assert.deepEqual(await repo.reverted([d.commit]), []);

		const undone = await repo.undo(d.commit);
		assert.doesNotMatch(readFileSync(join(clone, "inbox.md"), "utf8"), /Undo me/);
		await repo.sync();
		assert.equal(git(clone, "rev-parse", "origin/master").trim(), undone.commit);
		assert.equal(git(clone, "status", "--porcelain"), "");
		assert.match(readFileSync(join(clone, "INDEX.md"), "utf8"), /Next ID: \*\*16\*\*/);
		assert.deepEqual(await repo.reverted([d.commit]), [d.commit]);
		await assert.rejects(repo.undo(d.commit), /undone already/);
		// The next capture doesn't reuse #15.
		assert.equal(((await call("capture", { text: "After" })).details as IdeaToolDetails).id, 16);
	});

	test("a long diff is cut", async () => {
		const clone = setup();
		const r = await toolsFor(clone)("save_idea", { title: "Big", summary: "s", areas: [], idea: "x".repeat(20_000) });
		const d = r.details as IdeaToolDetails;
		assert.equal(d.diffTruncated, true);
		assert.equal(d.diff!.length, 12_000);
	});

	test("delete removes a file with its folder, or a capture's line; the number stays retired and undo brings it back", async () => {
		const clone = setup();
		const repo = new IdeasRepo(clone);
		const ops = createIdeasOps(repo, () => "2026-11-20");
		const folder = join(clone, "ideas", "2026-10-16-agent-quick-capture");
		mkdirSync(folder);
		writeFileSync(join(folder, "a.png"), "png");
		git(clone, "add", "-A");
		git(clone, "commit", "-q", "-m", "folder");
		git(clone, "push", "-q");

		const gone = await ops.delete(6);
		assert.equal(gone.title, "Agent quick-capture (Mac)");
		assert.equal(existsSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md")), false);
		assert.equal(existsSync(folder), false);
		assert.equal(git(clone, "log", "-1", "--format=%s").trim(), '#6: delete "Agent quick-capture (Mac)"');
		await repo.sync();
		assert.equal(git(clone, "rev-parse", "HEAD").trim(), git(clone, "rev-parse", "origin/master").trim());
		assert.doesNotMatch(readFileSync(join(clone, "INDEX.md"), "utf8"), /\| 6 \|/);

		await ops.delete(2);
		assert.doesNotMatch(readFileSync(join(clone, "inbox.md"), "utf8"), /#2 /);
		await assert.rejects(ops.delete(2), /No idea #2/);
		assert.equal((await readSnapshot(clone)).nextId, 15);

		await repo.undo(gone.commit);
		assert.equal(existsSync(join(folder, "a.png")), true);
		assert.deepEqual((await readSnapshot(clone)).ideas.map((i) => i.id), [6]);
		assert.equal(git(clone, "status", "--porcelain"), "");
	});

	test("a missing clone is an error the model can relay", async () => {
		const call = toolsFor(join(scratch, "nowhere"));
		const r = await call("capture", { text: "x" });
		assert.equal(r.isError, true);
		assert.match(r.text, /Clone the ideas repository/);
	});
});


describe("on the host", () => {
	const USER = "you@example.com";
	const lastUser = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
	/** The prompt and tools, which ride in the transcript's system messages: every tool added and not removed since. */
	const system = (ctx: TranscriptContext) => ctx.messages.filter((m) => m.role === "system") as unknown as Json[];
	const toolNames = (ctx: TranscriptContext) => {
		const offered = new Set<string>();
		for (const m of system(ctx)) {
			for (const tool of m.toolsRemoved ?? []) offered.delete(typeof tool === "string" ? tool : tool.name);
			for (const tool of m.toolsAdded ?? []) offered.add(tool.name);
		}
		return [...offered];
	};

	/**
	 * A faux host whose ideas.dir is a fresh clone, with its /app. "tools?" answers with the tools offered; "save idea:
	 * TITLE" calls save_idea; "about?" answers with the idea-chat section; the save-to-idea message calls update_idea.
	 */
	async function ideasHost(t: TestContext, options: { ideas?: boolean } = {}) {
		const dir = tempDir(t);
		const clone = setup(join(dir, "ideas-repo"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000 }] });
		faux.setResponses(Array.from({ length: 60 }, () => (ctx: TranscriptContext) => {
			const user = lastUser(ctx);
			// An updated prompt section can follow a tool's result, so the last message that isn't one.
			const last = ctx.messages.findLast((m) => m.role !== "system");
			if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`${last.toolName} returned: ${JSON.stringify(last.content)}`));
			if (/tools\?/.test(user)) return fauxAssistantMessage(fauxText(`Tools: ${toolNames(ctx).join(",")}`));
			if (/about\?/.test(user)) {
				const prompt = JSON.stringify(system(ctx)).replaceAll('\\"', '"');
				return fauxAssistantMessage(fauxText(`About: ${/This session is a brainstorm about idea #\d+[^\\]*/.exec(prompt)?.[0] ?? "nothing"}`));
			}
			const saved = /save idea: ([^"\\]+)/.exec(user)?.[1];
			if (saved !== undefined) return fauxAssistantMessage(fauxToolCall("save_idea", { title: saved, summary: "From a session", areas: ["other"], idea: "Talked through." }), { stopReason: "toolUse" });
			const save = /Save this chat to idea #(\d+)/.exec(user)?.[1];
			if (save !== undefined) return fauxAssistantMessage(fauxToolCall("update_idea", { id: Number(save), title: "Saved from a session", sections: [{ name: "Next steps", text: "- Agreed." }], log: "Saved from a session." }), { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxText("Hello."));
		}));
		const models = createModels();
		models.setProvider(faux.provider);
		const root = join(dir, "Projects", "Software");
		const { host } = await testHost(t, { dir, models, model: { provider: "faux", modelId: "faux-1" }, settings: { ...(options.ideas === false ? {} : { ideas: { dir: clone } }), newProjects: { root, owner: "t" } }, newProjects: fakeGh(join(dir, "github")) });
		const server = createApi(host, { users: [USER], name: "test-host", checkoutMs: 100 });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		t.after(() => server.close());
		const ws = new WebSocket(`ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/app`, { headers: { "tailscale-user-login": USER } });
		t.after(() => ws.close());
		const responses = new Map<string, Json>();
		const events: Json[] = [];
		ws.on("message", (data) => {
			const frame = JSON.parse(String(data));
			if (frame.type === "response") responses.set(frame.id, frame);
			if (frame.type === "event") events.push(...frame.events);
		});
		await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
		ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));
		let next = 0;
		const wait = async <T>(check: () => T | undefined, what: string, ms = 10_000): Promise<T> => {
			const until = Date.now() + ms;
			for (;;) {
				const found = check();
				if (found !== undefined) return found;
				if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const request = async (method: string, params: Json = {}): Promise<Json> => {
			const id = `r${++next}`;
			ws.send(JSON.stringify({ type: "request", id, method, params }));
			const response = await wait(() => responses.get(id), method);
			if (response.error !== undefined) throw Object.assign(new Error(response.error.message), { code: response.error.code, data: response.error.data });
			return response.result;
		};
		/** The first answer in session `id` that starts with `start`, once there is one. */
		const answer = async (id: number, start: string) => {
			const until = Date.now() + 15_000;
			for (;;) {
				const conversation = await host.conversation(id);
				const entries = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
				const texts = entries.flatMap((e: Json) => (e.kind === "pi.assistant" ? (e.model ?? []).flatMap((m: Json) => m.content ?? []).filter((b: Json) => b.type === "text").map((b: Json) => b.text as string) : []));
				const hit = texts.find((s: string) => s.startsWith(start));
				if (hit !== undefined) return hit;
				if (Date.now() > until) throw new Error(`timed out waiting for "${start}" in session ${id}; saw ${JSON.stringify(texts)}`);
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
		};
		let asked = 0;
		/** Sends `text` to session `id` and waits for the answer that starts with `start`. */
		const ask = async (id: number, text: string, start: string) => {
			await host.submit(id, text, { requestId: `ask:${++asked}` });
			return answer(id, start);
		};
		return { host, clone, root, request, events, ask, answer, wait };
	}

	test("only local no-project sessions get the ideas tools, and only on a host with ideas.dir", async (t) => {
		const { host, ask } = await ideasHost(t);
		const scratch = await host.sessions.createScratch("tools?");
		assert.match(await ask(scratch.id, "tools?", "Tools:"), /list_ideas,read_idea,capture,save_idea,update_idea,set_status/);
		const chat = await host.sessions.createChat(undefined, "tools?");
		assert.match(await ask(chat.id, "tools?", "Tools:"), /save_idea/);
		const project = await host.sessions.createChat({ workspace: "test", name: "one", path: "Software/one", dir: tempDir(t) }, "tools?");
		assert.doesNotMatch(await ask(project.id, "tools?", "Tools:"), /idea/);

		const without = await ideasHost(t, { ideas: false });
		const plain = await without.host.sessions.createScratch("tools?");
		assert.doesNotMatch(await without.ask(plain.id, "tools?", "Tools:"), /idea/);
		await assert.rejects(without.request("ideas.list"), { code: "unsupported" });
		assert.equal((await without.request("host.info")).ideas, undefined);
	});

	test("save_idea from a session lists it as host/session and makes the session about the idea", async (t) => {
		const { host, clone, ask } = await ideasHost(t);
		const session = await host.sessions.createScratch("save");
		assert.match(await ask(session.id, "save idea: Porch light", "save_idea returned:"), /Saved #15/);
		const saved = (await readSnapshot(clone)).ideas.find((i) => i.id === 15)!;
		assert.deepEqual(saved.sessions, [`${hostname().split(".")[0]}/${session.id}`]);
		for (let i = 0; i < 50 && (await host.sessions.get(session.id))?.idea === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal((await host.sessions.get(session.id))?.idea, 15);
		assert.match(await ask(session.id, "about?", "About:"), /idea #15, "Porch light"/);
	});

	test("ideas.* on /app: list, read, capture, status, areas, delete, undo, sync, and ideas.changed to host watchers", async (t) => {
		const { clone, request, events, wait } = await ideasHost(t);
		const info = await request("host.info");
		assert.equal(info.ideas.state, "ok");
		assert.equal(info.ideas.dir, clone);
		await request("host.watch");

		const list = await request("ideas.list");
		assert.deepEqual(list.ideas.map((i: Json) => i.id), [6]);
		assert.equal(list.ideas[0].body, undefined);
		assert.deepEqual(list.captures.map((c: Json) => c.id), [2]);
		const file = (await request("ideas.read", { id: 6 })).idea;
		assert.equal(file.kind, "file");
		assert.match(file.body, /## The idea/);
		assert.deepEqual(file.images, []);
		assert.equal((await request("ideas.read", { id: 2 })).idea.kind, "capture");
		await assert.rejects(request("ideas.read", { id: 99 }), { code: "not_found" });
		await assert.rejects(request("ideas.read", {}), { code: "bad_request" });

		const captured = (await request("ideas.capture", { text: "Tide clock" })).details;
		assert.equal(captured.id, 15);
		await wait(() => events.find((e) => e.type === "ideas.changed"), "host watchers to hear of the change");
		assert.equal((await request("ideas.setStatus", { id: 6, status: "parked" })).details.tool, "set_status");
		await assert.rejects(request("ideas.setStatus", { id: 6, status: "someday" }), { code: "bad_request", message: /isn't a status/ });
		await request("ideas.setAreas", { id: 6, areas: ["software", "video"] });
		assert.match(readFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), "utf8"), /areas: \[software, video\]/);
		await assert.rejects(request("ideas.setAreas", { id: 6, areas: ["cooking"] }), { code: "bad_request" });

		const undone = await request("ideas.undo", { commit: captured.commit });
		assert.match(undone.commit, /^[0-9a-f]{40}$/);
		assert.deepEqual((await request("ideas.reverted", { commits: [captured.commit] })).reverted, [captured.commit]);
		const removed = await request("ideas.delete", { id: 2 });
		assert.equal(removed.title, "Message board for the boy. Intercom?");
		const synced = (await request("ideas.sync")).status;
		assert.equal(synced.sync.state, "idle");
		assert.equal(synced.sync.pending, 0);
		assert.equal(git(clone, "rev-parse", "HEAD").trim(), git(clone, "rev-parse", "origin/master").trim());
	});

	test("ideas.file serves an image in the idea's folder and nothing outside it", async (t) => {
		const { clone, request } = await ideasHost(t);
		const folder = join(clone, "ideas", "2026-10-16-agent-quick-capture");
		mkdirSync(join(folder, "shots"), { recursive: true });
		writeFileSync(join(folder, "shots", "a.png"), "png bytes");
		writeFileSync(join(clone, "secret.png"), "not this");
		git(clone, "add", "-A");
		git(clone, "commit", "-q", "-m", "images");
		assert.deepEqual((await request("ideas.read", { id: 6 })).idea.images, ["shots/a.png"]);
		const found = await request("ideas.file", { id: 6, path: "shots/a.png" });
		assert.equal(found.mimeType, "image/png");
		assert.equal(Buffer.from(found.data, "base64").toString(), "png bytes");
		for (const path of ["../../secret.png", "shots/../../../secret.png", "notes.txt", ".hidden.png"]) await assert.rejects(request("ideas.file", { id: 6, path }), { code: "not_found" }, path);
	});

	test("ideas.brainstorm makes a no-project session about the idea, listed in its file, and Save to idea folds it in", async (t) => {
		const { clone, request, answer, host } = await ideasHost(t);
		const { conversation, linkError } = await request("ideas.brainstorm", { id: 6 });
		assert.equal(linkError, undefined);
		assert.equal(conversation.title, "Brainstorm: #6 Agent quick-capture (Mac)");
		assert.equal(conversation.idea, 6);
		assert.equal(conversation.project, undefined);
		const me = hostname().split(".")[0]!;
		assert.match(readFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), "utf8"), new RegExp(`sessions: \\[${me}/${conversation.id}\\]\\n`));
		assert.equal(git(clone, "log", "-1", "--format=%s").trim(), `#6: link session ${me}/${conversation.id}`);

		await host.submit(conversation.id, "about?", { requestId: "a1" });
		assert.match(await answer(conversation.id, "About:"), /idea #6, "Agent quick-capture \(Mac\)"/);
		await host.submit(conversation.id, saveToIdeaMessage(6), { requestId: "s1" });
		assert.match(await answer(conversation.id, "update_idea returned:"), /Updated #6/);
		assert.match(readFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), "utf8"), /## Next steps\n\n- Agreed.\n/);

		// A capture has no file to list the session in; promoting it from its brainstorm does.
		const onCapture = (await request("ideas.brainstorm", { id: 2 })).conversation;
		await host.submit(onCapture.id, saveToIdeaMessage(2), { requestId: "s2" });
		assert.match(await answer(onCapture.id, "update_idea returned:"), /Promoted #2/);
		assert.deepEqual((await readSnapshot(clone)).ideas.find((i) => i.id === 2)?.sessions, [`${me}/${onCapture.id}`]);
		await assert.rejects(request("ideas.brainstorm", { id: 99 }), { code: "not_found" });
	});

	test("ideas.draft and ideas.makeProject make a project from an idea's plan and set it to doing", async (t) => {
		const { clone, root, request } = await ideasHost(t);
		writeFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), IDEA.replace("## Next steps\n", "## Next steps\n\n- Build the **menu-bar** shell\n- [ ] Wire the hotkey\n"));
		git(clone, "commit", "-q", "-am", "steps");
		assert.deepEqual((await request("ideas.draft", { id: 6 })).draft, { name: "agent-quick-capture-mac", description: "Floating hotkey window", steps: ["Build the menu-bar shell", "Wire the hotkey"], questions: ["Is the list for the user or for agents?"] });
		await assert.rejects(request("ideas.draft", { id: 2 }), { code: "bad_request", message: /inbox capture/ });

		const made = await request("ideas.makeProject", { id: 6, name: "quick-capture" });
		assert.equal(made.project.dir, join(root, "quick-capture"));
		assert.equal(made.repository, "t/quick-capture");
		assert.match(readFileSync(join(made.project.dir, "docs", "plan.md"), "utf8"), /### build-the-menu-bar-shell: Build the menu-bar shell/);
		const file = readFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), "utf8");
		assert.match(file, /status: doing\n/);
		assert.match(file, /project: t\/quick-capture\n/);
		await assert.rejects(request("ideas.makeProject", { id: 6, name: "again" }), { code: "bad_request", message: /already the project t\/quick-capture/ });
		assert.equal(existsSync(join(root, "again")), false);
	});
});
