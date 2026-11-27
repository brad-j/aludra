// The ideas extension: tools the model uses to read and write the user's ideas repository through IdeasRepo
// (src/ideas-repo.ts), and the operations /app's Ideas methods share with them, so a change made either way is the same
// commit. Brought over from Pi Desktop's pi-host. The model never gets the clone's files; IDs, dates, file names and
// INDEX.md come from here.
//
// Only local no-project sessions select the extension (src/host.ts): a project's sessions are about its code, and a
// sandbox session runs untrusted code a tool call away from the clone's push access.
//
// Reads (list_ideas, read_idea) are replay-safe. Writes (capture, save_idea, update_idea, set_status) are not: Durable
// never reruns one interrupted by a crash, so a write can't commit twice. A write's result details carry the idea, the
// commit and its diff, for a client's diff and Undo.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as BACKGROUND, type Context } from "@earendil-works/chord/context";
import { type ConversationId, defineExtension, defineTool, type DocumentReader, section } from "@earendil-works/pi-durable";
import { IdeasError, type IdeasRepo, type IdeasSnapshot, ideaFolder, STATUSES, parseFrontmatter } from "./ideas-repo.ts";

/** The ideas repository's areas, as its README lists them. */
export const AREAS = ["art", "electronics", "fabrication", "software", "video", "other"] as const;

/** What an ideas tool that wrote reports: the idea, its file, and the commit, for a client's diff and Undo. */
export type IdeaToolDetails = {
	tool: "capture" | "save_idea" | "update_idea" | "set_status";
	id: number;
	title: string;
	/** Relative to the ideas repository: `inbox.md` for a capture. */
	path: string;
	commit: string;
	/** The commit's diff without INDEX.md, cut at IDEA_DIFF_MAX characters. Absent from /app's own changes. */
	diff?: string;
	diffTruncated?: boolean;
};

/** What a session about idea `id` is sent to fold what it settled into the file; the idea-chat section says what it means. */
export function saveToIdeaMessage(id: number): string {
	return `Save this chat to idea #${id}.`;
}
/** Fields that are written for the model, never by it. */
const LOG_HEADING = "Log";

export interface IdeasToolsOptions {
	repo: () => IdeasRepo | undefined;
	/** Today's date as YYYY-MM-DD; tests fix it. */
	today?: () => string;
	/** The idea session `conversationId` is about, if any, for its prompt. */
	sessionIdea: (read: DocumentReader, conversationId: ConversationId, context: Context) => Promise<number | undefined>;
	/** How an idea file names session `conversationId`: `<host>/<session>`. */
	sessionRef: (conversationId: number) => string;
	/** Told when save_idea saves an idea from session `conversationId`, so the session is about it from then on. */
	onSaved?: (conversationId: number, ideaId: number) => void | Promise<void>;
}

/** An idea file over this many characters is cut in a brainstorm's prompt; read_idea has the rest. */
const PROMPT_IDEA_MAX = 16_000;

type Output = { type: "text"; text: string }[];
const text = (t: string): Output => [{ type: "text", text: t }];

function localDate(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Collapses whitespace so a value stays on one frontmatter or inbox line. */
export function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export function slug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48)
			.replace(/-+$/, "") || "idea"
	);
}

const list = (items: readonly (string | number)[]) => `[${items.join(", ")}]`;

// ---- Editing a file ----

/** Sets frontmatter fields in place, keeping their order; new ones go at the end. */
export function setFields(text: string, updates: Record<string, string>): string {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (!match) throw new Error("The idea file has no frontmatter.");
	const lines = match[1]!.split("\n");
	for (const [key, value] of Object.entries(updates)) {
		const line = value === "" ? `${key}:` : `${key}: ${value}`;
		const at = lines.findIndex((l) => l.startsWith(`${key}:`));
		if (at === -1) lines.push(line);
		else lines[at] = line;
	}
	return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

const isHeading = (line: string) => line.startsWith("## ");
const headingIs = (line: string, name: string) => isHeading(line) && line.slice(3).trim().toLowerCase() === name.trim().toLowerCase();
const endNewline = (s: string) => s.replace(/\n*$/, "\n");

/** Replaces the text under `## name`; adds the section before Log (or at the end) when it isn't there. */
export function setSection(body: string, name: string, content: string): string {
	const lines = body.split("\n");
	const block = content.trim() ? ["", content.trim(), ""] : [""];
	const start = lines.findIndex((l) => headingIs(l, name));
	if (start === -1) {
		const log = lines.findIndex((l) => headingIs(l, LOG_HEADING));
		if (log === -1) {
			while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
			lines.push("", `## ${name}`, ...block);
		} else lines.splice(log, 0, `## ${name}`, ...block);
		return endNewline(lines.join("\n"));
	}
	let end = start + 1;
	while (end < lines.length && !isHeading(lines[end]!)) end++;
	lines.splice(start + 1, end - start - 1, ...block);
	return endNewline(lines.join("\n"));
}

/** Adds `- date: entry` at the end of the Log section, making one if needed. */
export function appendLog(body: string, line: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => headingIs(l, LOG_HEADING));
	if (start === -1) {
		while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
		lines.push("", `## ${LOG_HEADING}`, "", line);
		return endNewline(lines.join("\n"));
	}
	let end = start + 1;
	while (end < lines.length && !isHeading(lines[end]!)) end++;
	let last = end - 1;
	while (last > start && lines[last]!.trim() === "") last--;
	if (last === start) lines.splice(start + 1, end - start - 1, "", line, "");
	else lines.splice(last + 1, 0, line);
	return endNewline(lines.join("\n"));
}

const bullets = (items: readonly string[] | undefined) => (items ?? []).map((i) => `- ${oneLine(i)}`).join("\n");

/** A new idea file in TEMPLATE.md's shape. */
export function renderIdea(fields: {
	id: number;
	title: string;
	status: string;
	areas: readonly string[];
	created: string;
	updated: string;
	summary: string;
	sessions: readonly string[];
	idea: string;
	why?: string;
	openQuestions?: readonly string[];
	nextSteps?: readonly string[];
	log: string;
}): string {
	return [
		"---",
		`id: ${fields.id}`,
		`title: ${fields.title}`,
		`status: ${fields.status}`,
		`areas: ${list(fields.areas)}`,
		`created: ${fields.created}`,
		`updated: ${fields.updated}`,
		"related: []",
		"project:",
		`summary: ${fields.summary}`,
		`sessions: ${list(fields.sessions)}`,
		"---",
		"",
		`# ${fields.title}`,
		"",
		"## The idea",
		"",
		fields.idea.trim(),
		"",
		"## Why",
		...(fields.why?.trim() ? ["", fields.why.trim()] : []),
		"",
		"## Open questions",
		...(fields.openQuestions?.length ? ["", bullets(fields.openQuestions)] : []),
		"",
		"## Next steps",
		...(fields.nextSteps?.length ? ["", bullets(fields.nextSteps)] : []),
		"",
		"## Log",
		"",
		fields.log,
		"",
	].join("\n");
}

/** Writes an idea file, making ideas/ in a repository that has none yet. */
async function writeIdea(dir: string, path: string, file: string) {
	await mkdir(join(dir, "ideas"), { recursive: true });
	await writeFile(join(dir, path), file);
}

/** A path in ideas/ that isn't taken. */
function freePath(dir: string, date: string, title: string, id: number): string {
	const base = `ideas/${date}-${slug(title)}`;
	return existsSync(join(dir, `${base}.md`)) ? `${base}-${id}.md` : `${base}.md`;
}

/** The bullets under `## name` in an idea's body, as plain lines; nested and empty ones left out. */
export function sectionBullets(body: string, name: string): string[] {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => headingIs(l, name));
	if (start === -1) return [];
	const out: string[] = [];
	for (let i = start + 1; i < lines.length && !isHeading(lines[i]!); i++) {
		const m = /^[-*] (?:\[[ xX]\] )?(.+)$/.exec(lines[i]!);
		if (m) out.push(m[1]!.replace(/\*\*|__|`/g, "").trim());
	}
	return out.filter((x) => x !== "");
}

/** A project name from an idea's title: aludra's rule, lowercase letters, digits and -, at most 60 here. */
export function projectName(title: string): string {
	return slug(title).slice(0, 60).replace(/-+$/, "") || "project";
}

/** A frontmatter list with `item` added, or undefined when it's there already. */
function withItem(value: string | undefined, item: string): string | undefined {
	const items = value === undefined ? [] : value.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
	return items.includes(item) ? undefined : list([...items, item]);
}

function find(snapshot: IdeasSnapshot, id: number) {
	return { idea: snapshot.ideas.find((i) => i.id === id), capture: snapshot.captures.find((c) => c.id === id) };
}

async function removeInboxLine(dir: string, id: number) {
	const path = join(dir, "inbox.md");
	const lines = (await readFile(path, "utf8")).split("\n");
	await writeFile(path, lines.filter((l) => !l.startsWith(`- #${id} `)).join("\n"));
}

// ---- Operations ----
// Shared by the tools and the window's Ideas section, so a change made either way is the same commit.

export interface SaveArgs {
	title: string;
	summary: string;
	areas: readonly string[];
	idea: string;
	why?: string;
	open_questions?: readonly string[];
	next_steps?: readonly string[];
}

export interface UpdateArgs {
	id: number;
	title?: string;
	summary?: string;
	areas?: readonly string[];
	sections?: readonly { name: string; text: string }[];
	log?: string;
}

export function createIdeasOps(repo: IdeasRepo, today: () => string = localDate) {
	return {
		async capture(textIn: string): Promise<IdeaToolDetails> {
			const line = oneLine(textIn);
			if (!line) throw new IdeasError("git", "The capture is empty.");
			const date = today();
			const { commit, result: id } = await repo.write<number>(
				(id) => `#${id}: capture`,
				async (dir, snap) => {
					const path = join(dir, "inbox.md");
					const inbox = existsSync(path) ? await readFile(path, "utf8") : "# Inbox\n";
					await writeFile(path, `${endNewline(inbox)}- #${snap.nextId} ${date}: ${line}\n`);
					return snap.nextId;
				},
			);
			return { tool: "capture", id, title: line, path: "inbox.md", commit };
		},

		/** `session`: the session it came from, as `<host>/<session>`, listed in the new file. */
		async save(args: SaveArgs, session?: string): Promise<IdeaToolDetails> {
			const title = oneLine(args.title);
			const summary = oneLine(args.summary);
			if (!title || !summary) throw new IdeasError("git", "A title and a summary are needed.");
			const date = today();
			const { commit, result } = await repo.write<{ id: number; path: string }>(
				(r) => `#${r.id}: save "${title}"`,
				async (dir, snap) => {
					const id = snap.nextId;
					const path = freePath(dir, date, title, id);
					const file = renderIdea({
						id,
						title,
						status: "raw",
						areas: [...new Set(args.areas)],
						created: date,
						updated: date,
						summary,
						sessions: session === undefined ? [] : [session],
						idea: args.idea,
						why: args.why,
						openQuestions: args.open_questions,
						nextSteps: args.next_steps,
						log: `- ${date}: Saved from a session.`,
					});
					await writeIdea(dir, path, file);
					return { id, path };
				},
			);
			return { tool: "save_idea", id: result.id, title, path: result.path, commit };
		},

		/** `session`: the session this came from, as `<host>/<session>`, listed in a promoted capture's new file. */
		async update(args: UpdateArgs, session?: string): Promise<IdeaToolDetails & { promoted: boolean; changed: string[] }> {
			if (args.sections?.some((s) => s.name.trim().toLowerCase() === LOG_HEADING.toLowerCase())) {
				throw new IdeasError("git", "Log can't be replaced; add to it with log.");
			}
			const date = today();
			let title = "";
			let path = "";
			let promoted = false;
			const changed: string[] = [];
			const { commit } = await repo.write(
				() => `#${args.id}: ${promoted ? "promote to a file" : `update ${changed.join(", ") || "date"}`}`,
				async (dir, snap) => {
					const { idea, capture } = find(snap, args.id);
					if (!idea && !capture) throw new IdeasError("git", `No idea #${args.id}.`);
					let file: string;
					if (idea) {
						path = idea.path;
						title = args.title ? oneLine(args.title) : idea.title;
						file = await readFile(join(dir, path), "utf8");
					} else {
						if (!args.title?.trim()) throw new IdeasError("git", `#${args.id} is an inbox capture; give a title to promote it to a file.`);
						promoted = true;
						title = oneLine(args.title);
						path = freePath(dir, capture!.date, title, args.id);
						file = renderIdea({
							id: args.id,
							title,
							status: "raw",
							areas: [],
							created: capture!.date,
							updated: date,
							summary: capture!.text,
							sessions: session === undefined ? [] : [session],
							idea: capture!.text,
							log: `- ${capture!.date}: Captured in the inbox.\n- ${date}: Promoted to a file.`,
						});
						await removeInboxLine(dir, args.id);
					}
					const fields: Record<string, string> = { updated: date };
					if (args.title) {
						fields.title = title;
						changed.push("title");
					}
					if (args.summary !== undefined) {
						fields.summary = oneLine(args.summary);
						changed.push("summary");
					}
					if (args.areas) {
						fields.areas = list([...new Set(args.areas)]);
						changed.push("areas");
					}
					file = setFields(file, fields);
					const { body } = parseFrontmatter(file);
					let next = body;
					if (args.title && idea) next = next.replace(/^(\s*)# .*$/m, `$1# ${title}`);
					for (const s of args.sections ?? []) {
						next = setSection(next, s.name.trim(), s.text);
						changed.push(s.name.trim());
					}
					if (args.log?.trim()) {
						next = appendLog(next, `- ${date}: ${oneLine(args.log)}`);
						changed.push("Log");
					}
					file = file.slice(0, file.length - body.length) + next;
					await writeIdea(dir, path, file);
				},
			);
			return { tool: "update_idea", id: args.id, title, path, commit, promoted, changed };
		},

		/** Adds session `session` (`<host>/<session>`) to idea `id`'s `sessions:`, one commit; nothing when it's there already. */
		async linkSession(id: number, session: string): Promise<IdeaToolDetails> {
			let title = "";
			let path = "";
			const { commit } = await repo.write(`#${id}: link session ${session}`, async (dir, snap) => {
				const { idea, capture } = find(snap, id);
				if (!idea) throw new IdeasError("git", capture ? `#${id} is an inbox capture, with no file to list sessions in.` : `No idea #${id}.`);
				title = idea.title;
				path = idea.path;
				const sessions = withItem(idea.fields.sessions, session);
				if (sessions === undefined) return;
				const file = setFields(await readFile(join(dir, path), "utf8"), { sessions });
				await writeIdea(dir, path, file);
			});
			return { tool: "update_idea", id, title, path, commit };
		},

		/**
		 * Deletes idea `id`: a file with its folder of images and other files, or a capture's inbox line. One commit, which
		 * git revert brings back. INDEX.md keeps its next ID, so the number isn't given out again. Only /app calls this;
		 * the model has no tool for it.
		 */
		async delete(id: number): Promise<{ id: number; title: string; commit: string }> {
			if (!Number.isSafeInteger(id) || id <= 0) throw new IdeasError("git", "That isn't an idea's number.");
			let title = "";
			const { commit } = await repo.write(() => `#${id}: delete "${title}"`, async (dir, snap) => {
				const { idea, capture } = find(snap, id);
				if (idea) {
					title = idea.title;
					await rm(join(dir, idea.path), { force: true });
					await rm(join(dir, ideaFolder(idea.path)), { recursive: true, force: true });
				} else if (capture) {
					title = capture.text;
					await removeInboxLine(dir, id);
				} else {
					throw new IdeasError("git", `No idea #${id}.`);
				}
			});
			return { id, title, commit };
		},

		async setStatus(args: { id: number; status: string; project?: string; reason?: string }): Promise<IdeaToolDetails> {
			if (!(STATUSES as readonly string[]).includes(args.status)) throw new IdeasError("git", `${args.status} isn't a status.`);
			const date = today();
			let title = "";
			let path = "";
			const { commit } = await repo.write(`#${args.id}: status ${args.status}`, async (dir, snap) => {
				const { idea, capture } = find(snap, args.id);
				if (!idea) throw new IdeasError("git", capture ? `#${args.id} is an inbox capture; promote it with update_idea first.` : `No idea #${args.id}.`);
				title = idea.title;
				path = idea.path;
				const fields: Record<string, string> = { status: args.status, updated: date };
				if (args.project !== undefined) fields.project = oneLine(args.project);
				let file = setFields(await readFile(join(dir, path), "utf8"), fields);
				const { body } = parseFrontmatter(file);
				const why = args.reason?.trim() ? `: ${oneLine(args.reason)}` : "";
				const next = appendLog(body, `- ${date}: Status ${idea.status} → ${args.status}${why}`);
				file = file.slice(0, file.length - body.length) + next;
				await writeIdea(dir, path, file);
			});
			return { tool: "set_status", id: args.id, title, path, commit };
		},
	};
}

export type IdeasOps = ReturnType<typeof createIdeasOps>;

/** What a project made from idea file `id` starts from: its next steps and open questions become the plan. */
export async function projectDraft(repo: IdeasRepo, id: number): Promise<{ name: string; description: string; steps: string[]; questions: string[]; status: string; project?: string }> {
	const snap = await repo.read();
	const { idea, capture } = find(snap, id);
	if (!idea) throw new IdeasError("git", capture ? `#${id} is an inbox capture; promote it to a file before making it a project.` : `No idea #${id}.`);
	return {
		name: projectName(idea.title),
		description: idea.summary ?? idea.title,
		steps: sectionBullets(idea.body, "Next steps"),
		questions: sectionBullets(idea.body, "Open questions"),
		status: idea.status,
		...(idea.project ? { project: idea.project } : {}),
	};
}

// ---- Tools ----

function failure(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true as const, output: text(message) };
}

const short = (commit: string) => commit.slice(0, 7);

const NOT_SET = "This host has no ideas repository (ideas.dir isn't set in its settings).";
const id = (description: string) => Type.Integer({ minimum: 1, description });
const oneOf = <T extends readonly string[]>(values: T, description?: string) => Type.Union(values.map((v) => Type.Literal(v)), description === undefined ? {} : { description });

export function createIdeasTools(options: IdeasToolsOptions) {
	/** The repository and its operations, or why there are none. */
	const opened = () => {
		const repo = options.repo();
		return repo === undefined ? undefined : { repo, ops: createIdeasOps(repo, options.today) };
	};
	/** A write's details with its diff. A diff that can't be read leaves the change as is. */
	const withDiff = async (repo: IdeasRepo, details: IdeaToolDetails): Promise<IdeaToolDetails> => {
		try {
			const { diff, truncated } = await repo.diffOf(details.commit);
			return diff.trim() === "" ? details : { ...details, diff, ...(truncated ? { diffTruncated: true } : {}) };
		} catch {
			return details;
		}
	};

	const listIdeas = defineTool({
		name: "list_ideas",
		description:
			"List the user's ideas: each idea file (ID, status, areas, title, summary) and each inbox capture (a one-liner without a file). Filter by status, area or words in the title, summary or capture.",
		parameters: Type.Object({
			status: Type.Optional(oneOf(STATUSES, "Only ideas with this status. Captures have none and are left out.")),
			area: Type.Optional(oneOf(AREAS, "Only ideas tagged with this area.")),
			query: Type.Optional(Type.String({ description: "Words to look for, case-insensitive." })),
		}),
		replay: "safe",
		async execute(args) {
			const open = opened();
			if (open === undefined) return failure(NOT_SET);
			try {
				const snap = await open.repo.read();
				const q = args.query?.trim().toLowerCase();
				const has = (s: string | undefined) => !q || (s ?? "").toLowerCase().includes(q);
				const ideas = snap.ideas.filter((i) => (!args.status || i.status === args.status) && (!args.area || i.areas.includes(args.area)) && (has(i.title) || has(i.summary)));
				const captures = args.status || args.area ? [] : snap.captures.filter((c) => has(c.text));
				const lines = [
					...ideas.map((i) => `#${i.id} [${i.status}] ${i.title}${i.areas.length ? ` (${i.areas.join(", ")})` : ""}${i.summary ? `: ${i.summary}` : ""}${i.project ? ` → project ${i.project}` : ""}`),
					...captures.map((c) => `#${c.id} [capture ${c.date}] ${c.text}`),
				];
				return { output: text(lines.length ? lines.join("\n") : "No ideas match.") };
			} catch (error) {
				return failure(error);
			}
		},
	});

	const readIdea = defineTool({
		name: "read_idea",
		description: "Read one idea by its ID: the whole file, or the inbox line for a capture.",
		parameters: Type.Object({ id: id("The idea's ID, without #.") }),
		replay: "safe",
		async execute(args) {
			const open = opened();
			if (open === undefined) return failure(NOT_SET);
			try {
				const snap = await open.repo.read();
				const { idea, capture } = find(snap, args.id);
				if (idea) return { output: text(`${idea.path}\n\n${await readFile(join(open.repo.dir, idea.path), "utf8")}`) };
				if (capture) return { output: text(`#${capture.id} is an inbox capture from ${capture.date}, without a file:\n${capture.text}`) };
				return failure(`No idea #${args.id}.`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const capture = defineTool({
		name: "capture",
		description: "Add a one-line idea to the inbox, for a quick thought not worth a file yet. It gets the next ID. Use save_idea instead when there's more to keep.",
		parameters: Type.Object({ text: Type.String({ minLength: 1, description: "The idea in one line, in the user's words where possible." }) }),
		async execute(args) {
			const open = opened();
			if (open === undefined) return failure(NOT_SET);
			try {
				const details = await withDiff(open.repo, await open.ops.capture(args.text));
				return { output: text(`Captured #${details.id} in the inbox (commit ${short(details.commit)}).`), details };
			} catch (error) {
				return failure(error);
			}
		},
	});

	const saveIdea = defineTool({
		name: "save_idea",
		description:
			"Save a new idea as its own file, usually when the user says \"save this\" about something you've been discussing. Distill it: what the idea is, why it matters, the open questions and next steps. Don't paste the conversation. It gets the next ID, status raw, and a link to this session.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, description: "Short title." }),
			summary: Type.String({ minLength: 1, description: "One line for the list." }),
			areas: Type.Array(oneOf(AREAS), { description: "Areas it belongs to; as many as apply." }),
			idea: Type.String({ minLength: 1, description: "The idea itself, in Markdown." }),
			why: Type.Optional(Type.String({ description: "Why it's worth doing, in Markdown." })),
			open_questions: Type.Optional(Type.Array(Type.String(), { description: "Questions still open, one per item." })),
			next_steps: Type.Optional(Type.Array(Type.String(), { description: "Next steps, one per item." })),
		}),
		async execute(args, api) {
			const open = opened();
			if (open === undefined) return failure(NOT_SET);
			try {
				const session = Number(api.conversationId);
				const details = await withDiff(open.repo, await open.ops.save(args, options.sessionRef(session)));
				// After the call, not inside it: the session's record is committed outside the tool's own commit.
				setImmediate(() => void Promise.resolve(options.onSaved?.(session, details.id)).catch(() => undefined));
				return { output: text(`Saved #${details.id} "${details.title}" as ${details.path} (commit ${short(details.commit)}).`), details };
			} catch (error) {
				return failure(error);
			}
		},
	});

	const updateIdea = defineTool({
		name: "update_idea",
		description:
			"Change an idea: its title, summary or areas, the text under one or more of its sections (\"The idea\", \"Why\", \"Open questions\", \"Next steps\", or another heading in the file), and a line for its Log. Read it first. " +
			"A section's text replaces what's there, so include what should stay. For an inbox capture this promotes it to its own file with the same ID; give a title.",
		parameters: Type.Object({
			id: id("The idea's ID, without #."),
			title: Type.Optional(Type.String({ description: "New title. Needed to promote a capture." })),
			summary: Type.Optional(Type.String({ description: "New one-line summary." })),
			areas: Type.Optional(Type.Array(oneOf(AREAS), { description: "The areas, replacing the current list." })),
			sections: Type.Optional(
				Type.Array(Type.Object({ name: Type.String({ minLength: 1, description: "The heading, without ##." }), text: Type.String({ description: "Markdown that replaces the section's text." }) }), {
					description: "Sections to replace. Not Log; use log.",
				}),
			),
			log: Type.Optional(Type.String({ description: "One line for the Log, about what changed and why. Dated for you." })),
		}),
		async execute(args, api, context) {
			const open = opened();
			if (open === undefined) return failure(NOT_SET);
			try {
				// A capture promoted from a session about it lists that session, as a brainstorm on a file does.
				const about = await options.sessionIdea(api, api.conversationId, context);
				const session = about === args.id ? options.sessionRef(Number(api.conversationId)) : undefined;
				const { promoted, changed, ...written } = await open.ops.update(args, session);
				const details = await withDiff(open.repo, written);
				const what = promoted ? `Promoted #${args.id} to ${details.path}` : `Updated #${args.id} (${changed.join(", ") || "nothing but the date"})`;
				return { output: text(`${what} (commit ${short(details.commit)}).`), details };
			} catch (error) {
				return failure(error);
			}
		},
	});

	const setStatus = defineTool({
		name: "set_status",
		description:
			"Set an idea's status: raw (just captured), exploring (being thought through), parked (worth keeping, not now), doing (became a project; give the project), dropped (decided against; say why in reason).",
		parameters: Type.Object({
			id: id("The idea's ID, without #."),
			status: oneOf(STATUSES),
			project: Type.Optional(Type.String({ description: "With doing: the project's repository or path." })),
			reason: Type.Optional(Type.String({ description: "A line for the Log saying why." })),
		}),
		async execute(args) {
			const open = opened();
			if (open === undefined) return failure(NOT_SET);
			try {
				const details = await withDiff(open.repo, await open.ops.setStatus(args));
				return { output: text(`#${args.id} is now ${args.status} (commit ${short(details.commit)}).`), details };
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [listIdeas, readIdea, capture, saveIdea, updateIdea, setStatus];
}

/**
 * What a session about idea `id` is told: the idea as it is now, and how to keep it current. Undefined when the idea
 * can't be read; the session goes on without it.
 */
export async function ideaChatSection(repo: IdeasRepo, id: number): Promise<string | undefined> {
	const snap = await repo.read().catch(() => undefined);
	if (!snap) return undefined;
	const { idea, capture } = find(snap, id);
	const how =
		"Help the user think it through: ask what's unclear, push on the weak parts, and bring in what you know. Don't change the idea on every turn. " +
		"When something is settled, or the user asks, record it with update_idea (the sections it changes and a Log line), and set_status when its status changes.";
	const save =
		`When the user sends "${saveToIdeaMessage(id)}", fold everything this session settled into the file with one update_idea call: ` +
		"rewrite The idea and Why where the session changed them, Open questions with what's still open (dropping ones answered), Next steps with what was agreed, " +
		"and the summary if it no longer fits; keep what the session didn't touch; a distilled record, not a transcript. Add a Log line saying what this session decided. " +
		"If nothing new was settled, say so and change nothing.";
	if (capture) {
		return `This session is a brainstorm about idea #${id}, an inbox capture from ${capture.date} with no file yet:\n\n${capture.text}\n\n${how} To keep it, promote it with update_idea, giving a title.\n\n${save} As a capture it has no file yet: that call promotes it, so give it a title, a summary and its areas too.`;
	}
	if (!idea) return undefined;
	let body = await readFile(join(repo.dir, idea.path), "utf8").catch(() => "");
	if (!body) return undefined;
	if (body.length > PROMPT_IDEA_MAX) body = `${body.slice(0, PROMPT_IDEA_MAX)}\n\n[Cut here; read_idea ${id} has the rest.]`;
	return `This session is a brainstorm about idea #${id}, "${idea.title}". The file as it was when this message was sent:\n\n${body}\n\n${how}\n\n${save}`;
}

export const IDEAS_EXTENSION = "aludra-ideas";

export function ideasExtension(options: IdeasToolsOptions) {
	return defineExtension({
		name: IDEAS_EXTENSION,
		tools: createIdeasTools(options),
		sections: [
			section("ideas", () =>
				options.repo() === undefined
					? undefined
					: "The user keeps their ideas in a Git repository you reach through list_ideas, read_idea, capture, save_idea, update_idea and set_status. Every idea has a permanent ID (#7), assigned by the tools. " +
						"capture is for a quick one-liner; save_idea is for \"save this\" after a discussion, distilled rather than transcribed. Read an idea before you change it. Each change is its own commit, which the user can undo.",
			),
			section("idea-chat", async ({ conversationId, read }) => {
				const repo = options.repo();
				const id = repo === undefined ? undefined : await options.sessionIdea(read, conversationId, BACKGROUND);
				return repo === undefined || id === undefined ? undefined : ideaChatSection(repo, id);
			}),
		],
	});
}
