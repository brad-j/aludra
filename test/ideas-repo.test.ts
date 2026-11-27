// The ideas clone (src/ideas-repo.ts, from Pi Desktop's pi-host) against a local bare repository: status, reads, writes that commit
// locally, background syncs that rebase and push, INDEX.md regenerated, undo, and
// failures that leave the clone as it was.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { IdeasError, IdeasRepo, parseIdea, parseInbox, parseIndex, readSnapshot, renderIndex } from "../src/ideas-repo.ts";

const scratch = mkdtempSync(join(tmpdir(), "aludra-ideas-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

const IDEA = `---
id: 6
title: Agent quick-capture (Mac)
status: raw
areas: [software]
created: 2026-10-16
updated: 2026-10-16
related: []
project:
---

# Agent quick-capture (Mac)

## The idea
`;
const INBOX = `# Inbox

- #2 2026-08-20: Message board for the boy. Intercom?
- #14 2026-11-06: Chrome extension: YouTube marker tool — save timestamped markers.
`;
const INDEX = `# Index

| ID | Idea | Status | Areas | Summary |
|----|------|--------|-------|---------|
| 6 | [Agent quick-capture (Mac)](ideas/2026-10-16-agent-quick-capture.md) | raw | software | Floating hotkey window; a | b |

Inbox one-liners in \`inbox.md\` also carry IDs from the same sequence. Next ID: **16**
`;

let n = 0;
/** A bare "GitHub" with the ideas files, and a clone of it. */
function setup(): { origin: string; clone: string; other: string } {
	const base = join(scratch, String(++n));
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
	const other = join(base, "other");
	git(base, "clone", "-q", origin, clone);
	git(base, "clone", "-q", origin, other);
	return { origin, clone, other };
}

describe("parsing", () => {
	test("an idea file's frontmatter", () => {
		const idea = parseIdea(IDEA, "ideas/x.md")!;
		assert.equal(idea.id, 6);
		assert.equal(idea.title, "Agent quick-capture (Mac)");
		assert.deepEqual(idea.areas, ["software"]);
		assert.equal(idea.project, undefined);
		assert.match(idea.body, /^\n# Agent quick-capture/);
		assert.deepEqual(idea.chats, []);
		assert.deepEqual(parseIdea(IDEA.replace("project:\n", "project:\nchats: [12, 40, x]\n"), "x.md")!.chats, [12, 40]);
		assert.deepEqual(parseIdea(IDEA.replace("project:\n", "project:\nsessions: [egwene/3, bad, mac/12]\n"), "x.md")!.sessions, ["egwene/3", "mac/12"]);
		assert.equal(parseIdea("no frontmatter", "x.md"), undefined);
	});

	test("inbox lines and INDEX.md rows", () => {
		assert.deepEqual(parseInbox(INBOX).map((c) => c.id), [2, 14]);
		assert.equal(parseInbox(INBOX)[1]!.date, "2026-11-06");
		const index = parseIndex(INDEX);
		assert.equal(index.nextId, 16);
		// An unescaped | in the old summary splits the row; the first cell wins.
		assert.equal(index.summaries.get(6), "Floating hotkey window; a");
	});
});

describe("the clone", () => {
	test("status says what's wrong", async () => {
		assert.equal((await new IdeasRepo(join(scratch, "nope")).status()).state, "missing");
		const plain = join(scratch, "plain");
		mkdirSync(plain);
		assert.equal((await new IdeasRepo(plain).status()).state, "not_repo");
		const { clone } = setup();
		const repo = new IdeasRepo(clone);
		const ok = await repo.status();
		assert.equal(ok.state, "ok");
		assert.equal(ok.branch, "master");
		writeFileSync(join(clone, "inbox.md"), "edited by hand");
		assert.equal((await repo.status()).state, "dirty");
	});

	test("the next ID never goes back below INDEX.md's", async () => {
		const { clone } = setup();
		assert.equal((await readSnapshot(clone)).nextId, 16);
	});

	test("a write commits, regenerates INDEX.md and syncs after; a sync elsewhere brings it in", async () => {
		const { clone, other } = setup();
		const repo = new IdeasRepo(clone);
		const { commit, result } = await repo.write("#16: capture", async (dir, snap) => {
			const id = snap.nextId;
			writeFileSync(join(dir, "inbox.md"), `${readFileSync(join(dir, "inbox.md"), "utf8")}- #${id} 2026-11-19: A test capture.\n`);
			return id;
		});
		assert.equal(result, 16);
		assert.match(commit, /^[0-9a-f]{40}$/);
		const index = readFileSync(join(clone, "INDEX.md"), "utf8");
		assert.match(index, /Next ID: \*\*17\*\*/);
		// The old summary is kept, its | escaped.
		assert.match(index, /\| 6 \| \[Agent quick-capture \(Mac\)\]\(ideas\/2026-10-16-agent-quick-capture.md\) \| raw \| software \| Floating hotkey window; a \|/);
		assert.equal(git(clone, "status", "--porcelain"), "");
		await repo.sync();
		assert.equal(git(clone, "rev-parse", "origin/master").trim(), commit);
		assert.equal((await repo.status()).sync?.pending, 0);
		const elsewhere = new IdeasRepo(other);
		await elsewhere.sync();
		const fromOther = await elsewhere.read();
		assert.deepEqual(fromOther.captures.map((c) => c.id), [2, 14, 16]);
		assert.equal(fromOther.nextId, 17);
	});

	test("after a sync, IDs follow the other machine's", async () => {
		const { clone, other } = setup();
		const mac = new IdeasRepo(other);
		await mac.write("#16", async (dir, snap) => {
			writeFileSync(join(dir, "inbox.md"), `${INBOX}- #${snap.nextId} 2026-11-19: From the Mac.\n`);
		});
		await mac.sync();
		const repo = new IdeasRepo(clone);
		await repo.sync();
		const { result } = await repo.write("#17", async (_dir, snap) => snap.nextId);
		assert.equal(result, 17);
	});

	test("a write works offline; it waits, retries, and goes up once GitHub answers", async () => {
		const { clone, origin } = setup();
		const url = git(clone, "remote", "get-url", "origin").trim();
		git(clone, "remote", "set-url", "origin", join(origin, "..", "gone.git"));
		const repo = new IdeasRepo(clone, { retryMs: [60_000] });
		const changed: number[] = [];
		repo.onChange(() => changed.push(1));
		const { commit } = await repo.write("#16: capture", async (dir) => writeFileSync(join(dir, "inbox.md"), `${INBOX}- #16 2026-11-19: Offline.\n`));
		assert.equal(git(clone, "rev-parse", "HEAD").trim(), commit);
		await repo.sync();
		const failed = (await repo.status()).sync!;
		assert.equal(failed.state, "error");
		assert.equal(failed.pending, 1);
		assert.match(failed.error!, /Couldn't fetch/);
		assert.ok(failed.retryAt! > Date.now());
		assert.ok(changed.length > 0, "the window hears about the failure");
		// Reads still work, from the clone.
		assert.deepEqual((await repo.read()).captures.map((c) => c.id), [2, 14, 16]);

		git(clone, "remote", "set-url", "origin", url);
		await repo.sync();
		const ok = (await repo.status()).sync!;
		assert.equal(ok.state, "idle");
		assert.equal(ok.pending, 0);
		assert.equal(ok.retryAt, undefined);
		assert.ok(ok.lastSynced);
		assert.equal(git(clone, "rev-parse", "origin/master").trim(), commit);
		repo.close();
	});

	test("captures made on two machines between syncs both survive, and a number used twice is flagged", async () => {
		const { clone, other } = setup();
		const capture = (text: string) => async (dir: string, snap: { nextId: number }) => {
			writeFileSync(join(dir, "inbox.md"), `${readFileSync(join(dir, "inbox.md"), "utf8")}- #${snap.nextId} 2026-11-21: ${text}\n`);
			return snap.nextId;
		};
		const mac = new IdeasRepo(other);
		const repo = new IdeasRepo(clone);
		assert.equal((await mac.write("#16: capture", capture("From the Mac."))).result, 16);
		await mac.sync();
		assert.equal((await repo.write("#16: capture", capture("From egwene."))).result, 16);
		await repo.sync();
		const status = (await repo.status()).sync!;
		assert.equal(status.state, "idle");
		assert.equal(status.pending, 0);
		const inbox = readFileSync(join(clone, "inbox.md"), "utf8");
		assert.match(inbox, /- #16 2026-11-21: From the Mac.\n/);
		assert.match(inbox, /- #16 2026-11-21: From egwene.\n/);
		assert.match(status.warning!, /#16 is used twice/);
		// INDEX.md was regenerated, so the next number is past both.
		assert.match(readFileSync(join(clone, "INDEX.md"), "utf8"), /Next ID: \*\*17\*\*/);
		assert.equal(git(clone, "status", "--porcelain"), "");
		assert.equal(git(clone, "rev-parse", "HEAD").trim(), git(clone, "rev-parse", "origin/master").trim());
	});

	test("a write that throws leaves the clone where it started", async () => {
		const { clone } = setup();
		const head = git(clone, "rev-parse", "HEAD");
		await assert.rejects(
			new IdeasRepo(clone).write("broken", async (dir) => {
				writeFileSync(join(dir, "inbox.md"), "half written");
				writeFileSync(join(dir, "stray.md"), "new file");
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal(git(clone, "rev-parse", "HEAD"), head);
		assert.equal(git(clone, "status", "--porcelain"), "");
	});

	test("a dirty clone refuses writes", async () => {
		const { clone } = setup();
		writeFileSync(join(clone, "inbox.md"), "edited by hand");
		await assert.rejects(new IdeasRepo(clone).write("x", async () => undefined), (e: unknown) => e instanceof IdeasError && e.code === "dirty");
		assert.equal(readFileSync(join(clone, "inbox.md"), "utf8"), "edited by hand");
	});

	test("a local commit that conflicts with GitHub's stops syncing and is left alone", async () => {
		const { clone, other } = setup();
		const mac = new IdeasRepo(other);
		const file = "ideas/2026-10-16-agent-quick-capture.md";
		await mac.write("other", async (dir) => writeFileSync(join(dir, file), IDEA.replace("status: raw", "status: parked")));
		await mac.sync();
		const repo = new IdeasRepo(clone);
		await repo.write("here", async (dir) => writeFileSync(join(dir, file), IDEA.replace("status: raw", "status: doing")));
		const head = git(clone, "rev-parse", "HEAD");
		await repo.sync();
		const sync = (await repo.status()).sync!;
		assert.equal(sync.state, "conflict");
		assert.equal(sync.pending, 1);
		assert.match(sync.error!, /ideas\/2026-10-16-agent-quick-capture.md conflict with changes from another machine/);
		assert.equal(git(clone, "rev-parse", "HEAD"), head);
		assert.equal(git(clone, "status", "--porcelain"), "");
		// Writes still go to the clone; syncing waits for a person.
		await repo.write("more", async (dir) => writeFileSync(join(dir, "inbox.md"), `${INBOX}- #16 2026-11-21: Still works.\n`));
		assert.equal((await repo.status()).sync!.pending, 2);
	});

	test("a read works offline with the clone as it is", async () => {
		const { clone, origin } = setup();
		rmSync(origin, { recursive: true, force: true });
		const snap = await new IdeasRepo(clone).read();
		assert.deepEqual(snap.ideas.map((i) => i.id), [6]);
	});

	test("undo reverts the commit, and the revert syncs", async () => {
		const { clone } = setup();
		const repo = new IdeasRepo(clone);
		const before = readFileSync(join(clone, "inbox.md"), "utf8");
		const { commit } = await repo.write("#16", async (dir) => writeFileSync(join(dir, "inbox.md"), `${before}- #16 2026-11-19: Undo me.\n`));
		const undone = await repo.undo(commit);
		assert.equal(readFileSync(join(clone, "inbox.md"), "utf8"), before);
		await repo.sync();
		assert.equal(git(clone, "rev-parse", "origin/master").trim(), undone.commit);
		await assert.rejects(repo.undo("not a sha"), /isn't a commit/);
	});

	test("undo finds a commit a sync rebased, by the id the chat still holds", async () => {
		const { clone, other } = setup();
		const mac = new IdeasRepo(other);
		await mac.write("mac", async (dir) => writeFileSync(join(dir, "ideas", "2026-11-21-other.md"), "---\nid: 20\ntitle: Other\n---\n"));
		await mac.sync();
		const repo = new IdeasRepo(clone);
		const { commit } = await repo.write("#16", async (dir) => writeFileSync(join(dir, "inbox.md"), `${INBOX}- #16 2026-11-19: Undo me later.\n`));
		await repo.sync();
		assert.notEqual(git(clone, "rev-parse", "HEAD").trim(), commit, "the sync rebased it");
		assert.deepEqual(await repo.reverted([commit]), []);
		await repo.undo(commit);
		assert.doesNotMatch(readFileSync(join(clone, "inbox.md"), "utf8"), /Undo me later/);
		assert.deepEqual(await repo.reverted([commit]), [commit]);
	});

	test("INDEX.md uses an idea's own summary once it has one", async () => {
		const { clone } = setup();
		writeFileSync(join(clone, "ideas", "2026-10-16-agent-quick-capture.md"), IDEA.replace("project:\n", "project:\nsummary: From the frontmatter\n"));
		assert.match(await renderIndex(clone), /\| software \| From the frontmatter \|/);
	});
});
