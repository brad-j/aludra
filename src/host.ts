// The host: one Pi Durable Harness over SQLite in the data directory. Each session is an ownerless conversation whose
// agent `cwd` is its project's directory; the root conversation only carries aludra's session-wide documents.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { type CompactionPolicy, configure as configureAgent, type ConversationId, createRegistry, defineDoc, type EntryId, Harness, type Extension, type ModelRef } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ModelChoice, Settings } from "./api-types.ts";
import { claudeCodeProvider, loadClaudeCode, PROVIDER } from "./claude-code.ts";
import { choiceOf, createCatalog, displayName } from "./catalog.ts";
import { credentialsFile, fileCredentialStore } from "./credentials.ts";
import { type Snapshot, snapshot } from "./changes.ts";
import { createCheckpoints, restoreNoteText } from "./checkpoints.ts";
import { claudeConfigDir, type Config, expandHome, type Thinking } from "./config.ts";
import { type ImageInput, readImage } from "./images.ts";
import { AGENT_DIR, contextExtension, type Place } from "./context.ts";
import { ApprovalService, permissionsExtension } from "./permissions.ts";
import { HUES } from "./project-colors.ts";
import { findProjects, type Project } from "./projects.ts";
import { type Json, ParseError } from "./parse.ts";
import { changeSettings, describeSettings, SettingsError, writeSettings } from "./settings.ts";
import { messagesOf, openSearch } from "./search.ts";
import { type Exchange, excerptOf, modelTitler, type Titler, titleModels } from "./titles.ts";
import { itemsOf, textOf } from "./transcript.ts";
import { fileBlocks, type FileInput, isLong, preview, saveFiles, withoutFileNotes } from "./files.ts";
import { saveVideos, sweepUploads, type VideoInput, videoBlocks, withoutVideoNotes } from "./videos.ts";

export const context = BACKGROUND_CONTEXT;

export type SessionRecord = {
	id: number;
	workspace: string;
	project: string;
	dir: string;
	/** The first line of the first message, until a model writes one (src/titles.ts) or someone renames it. */
	title: string;
	/** Who wrote the title: a model, or someone by hand. Unset, it's the first message's first line. */
	titled?: "model" | "user";
	/** Hidden from the lists; nothing else changes, and running work goes on. */
	archived?: boolean;
	createdAt: number;
	/** The project's files when it started, for its changes (src/changes.ts); or why there's no snapshot. */
	base?: Snapshot;
	baseError?: string;
	/** A no-project session: `dir` is its own scratch directory, and `project` is NO_PROJECT. */
	scratch?: boolean;
};

/** The project name of a session that isn't in a project (T3 Code's "no project" threads). */
export const NO_PROJECT = "no project";

/** Something to do later: a first message, filed under its project, not sent yet. */
export type IdeaRecord = { id: number; workspace: string; project: string; dir: string; text: string; createdAt: number };

export const Ideas = defineDoc<{ next: number; ideas: Record<string, IdeaRecord> }>({
	kind: "aludra.ideas",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, ideas: {} }),
});

/** How many project hues there are (src/project-colors.ts, amyrlin's ProjectColor); a color is an index into them. */
export const PROJECT_HUES = HUES.length;

/** Projects whose color was picked rather than hashed from the name: name to hue index. */
export const Colors = defineDoc<{ colors: Record<string, number> }>({
	kind: "aludra.colors",
	version: 1,
	scope: "session",
	initial: () => ({ colors: {} }),
});

export const Sessions = defineDoc<{ sessions: Record<string, SessionRecord> }>({
	kind: "aludra.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
});

export function conversationId(id: number): ConversationId {
	// SAFETY: a session's id is the id Pi Durable gave its conversation, or a number from the user that's only looked up.
	return id as ConversationId;
}

/** What the faux model answers a message asking for "markdown": enough to check how answers render. */
const FAUX_MARKDOWN = [
	"Here's what changed, in **three** parts:",
	"",
	"1. `src/api.ts` serves the API.",
	"2. The socket sends each session's transcript as it grows.",
	"3. Approvals answer over HTTP.",
	"",
	"```ts",
	"const server = createApi(host, { user });",
	"server.listen(8724);",
	"const routes = [\"/api/bootstrap\", \"/api/sessions\", \"/api/sessions/:id/changes\", \"/api/push/subscribe\"];",
	"```",
	"",
	"| Check | Result |",
	"| --- | --- |",
	"| tsc | passed |",
	"| tests | 26 passed |",
	"",
	"> Nothing is pushed yet.",
].join("\n");

/**
 * The faux model runs a script with no network or key: each request after a tool result answers with it, a message
 * asking for "markdown" gets FAUX_MARKDOWN, "write a file for NAME" writes notes-NAME.md and edits NAME.txt, one saying "push" runs
 * `git push --dry-run` (which waits for approval), and
 * any other request calls bash once, with a sleep long enough to kill the process during it.
 */
function fauxModels(): { models: Models; model: ModelRef } {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	faux.setResponses(Array.from({ length: 1000 }, () => (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`Tool came back: ${JSON.stringify(last.content)}`));
		if (/markdown/i.test(JSON.stringify(last?.content))) return fauxAssistantMessage(fauxText(FAUX_MARKDOWN));
		// "write a file for NAME" writes notes-NAME.md and edits NAME.txt, for the changes view.
		const name = /write a file for (\w+)/i.exec(JSON.stringify(last?.content))?.[1];
		if (name !== undefined) {
			return fauxAssistantMessage([
				fauxToolCall("write", { path: `notes-${name}.md`, content: "# Notes\n\nWritten by the session.\n" }),
				fauxToolCall("edit", { path: `${name}.txt`, edits: [{ oldText: "Started.", newText: "Changed by the session." }] }),
			], { stopReason: "toolUse" });
		}
		// Waits for approval, then fails harmlessly: the e2e projects have no remote.
		if (/\bpush\b/i.test(JSON.stringify(last?.content))) return fauxAssistantMessage(fauxToolCall("bash", { command: "git push --dry-run 2>&1 || true" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 4 && pwd" }), { stopReason: "toolUse" });
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

export type HostOptions = {
	config: Config;
	/** A model in place of the settings' one; tests pass a faux one. */
	models?: Models;
	model?: ModelRef;
	/** A provider in place of pi-claude-code's; tests pass a faux one. */
	claudeCode?: Provider;
	/** Where AGENTS.md and skills are looked for besides the project. Default: ~/.pi/agent. */
	agentDir?: string;
	/** Over Pi Durable's compaction defaults; the live check keeps less so a small conversation compacts. */
	compaction?: Partial<CompactionPolicy>;
	/** Writes sessions' titles. Default: the smallest model on hand (src/titles.ts); none for the faux model, given models or a given Claude Code provider. */
	titler?: Titler;
};

export async function openHost(options: HostOptions) {
	const { config } = options;
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

	let models: Models;
	let model: ModelRef;
	const agentDir = options.agentDir ?? AGENT_DIR;
	// What a no-project session is told about this machine: each workspace's directory, and where agent histories are.
	const places = (): Place[] => [
		...config.workspaces.flatMap((w) => w.roots.map((root) => ({ path: expandHome(root.split("/*")[0]!), what: `projects in the ${w.name} workspace (${root.replace(/^.*?\/\*/, "*")})` }))),
		{ path: resolve(agentDir, "sessions"), what: "terminal pi's session history (JSONL)" },
		{ path: resolve(claudeConfigDir(config), "projects"), what: "Claude Code's session history (JSONL, a directory per project)" },
		{ path: resolve(config.dataDir, "aludra.sqlite"), what: "aludra's own sessions (Pi Durable on SQLite)" },
	];
	const extensions: Extension[] = [CodingTools, contextExtension(agentDir, { scratchRoot: resolve(config.dataDir, "scratch"), places })];
	if (options.models !== undefined && options.model !== undefined) {
		models = options.models;
		model = options.model;
	} else if (config.model.provider === "faux" && options.claudeCode === undefined) {
		({ models, model } = fauxModels());
	} else {
		// Claude Code only when the settings name a Claude model, so it's needed only for Claude. OpenAI and
		// OpenRouter always: they cost nothing until signed in, and their models are then in the pickers.
		const used = new Set([config.model.provider, ...config.model.choices.map((c) => c.provider)]);
		const mutable = createModels({ credentials: fileCredentialStore(credentialsFile(config.dataDir)) });
		if (used.has(PROVIDER) || options.claudeCode !== undefined) {
			const claude = claudeCodeProvider(options.claudeCode ?? (await loadClaudeCode(config.claude.path)));
			mutable.setProvider(claude.provider);
			extensions.push(claude.extension);
			// The models this Claude account offers, from Claude Code; on failure, the provider's built-in list.
			const { errors } = await mutable.refresh({ providers: [PROVIDER] });
			for (const error of errors.values()) console.error(`[models] couldn't list Claude Code's models: ${error.message}`);
		}
		mutable.setProvider(openaiProvider());
		mutable.setProvider(openrouterProvider());
		const openai = await mutable.checkAuth("openai");
		if (used.has("openai") && openai === undefined) console.error("[models] OpenAI's models are in model.choices, but this machine isn't signed in; run: aludra login openai");
		else if (openai?.type === "api_key") console.error(`[models] OpenAI's models run on ${openai.source ?? "an API key"}, billed per token; aludra login openai uses a ChatGPT plan instead`);
		if (used.has("openrouter") && (await mutable.checkAuth("openrouter")) === undefined) console.error("[models] OpenRouter's models are in model.choices, but this machine isn't signed in; run: aludra login openrouter");
		models = mutable;
		model = { provider: config.model.provider, modelId: config.model.id };
		if (models.getModel(model.provider, model.modelId) === undefined) throw new Error(`${model.provider === PROVIDER ? "Claude Code" : model.provider} has no model ${model.modelId}`);
	}

	// Tests' models and faux Claude Code providers script every answer, so they get titles only from a titler they pass.
	const real = options.models === undefined && options.claudeCode === undefined && config.model.provider !== "faux";
	const titler = options.titler ?? (real ? modelTitler(models, titleModels(models, config)) : undefined);

	let approvals: ApprovalService | undefined;
	let opened: Harness | undefined;
	const checkpoints = createCheckpoints({ harness: () => opened!, context, baseOf: async (id) => (await get(id))?.base });
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	registry.install(checkpoints.extension);
	// Last, so it wraps the tools the others bring, and other hooks see a call before it waits for the user.
	registry.install(permissionsExtension({ approvals: () => approvals!, hosts: () => config.approvals.hosts }));

	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(config.dataDir, "aludra.sqlite")),
		{
			models,
			registry,
			...(options.compaction === undefined ? {} : { settings: { compaction: options.compaction } }),
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	opened = harness;
	approvals = new ApprovalService(harness, () => config.approvals.waitHours * 3_600_000);
	const root = await harness.root(context);
	const created = new Set<(session: SessionRecord) => void>();

	const projects = (): Project[] => findProjects(config.workspaces);
	/** Where no-project sessions keep the files they make, one directory per session. */
	const scratchRoot = resolve(config.dataDir, "scratch");
	/** Where videos sent with messages are kept, one directory per session, until sweepUploads takes them. */
	const uploads = resolve(config.dataDir, "uploads");
	const sweep = () => void sweepUploads(uploads).catch((error) => console.error(`[uploads] ${error instanceof Error ? error.message : String(error)}`));
	sweep();
	const sweeper = setInterval(sweep, 3_600_000);
	sweeper.unref();

	// Search over what was said (src/search.ts), in its own file beside the database.
	const searchIndex = openSearch(resolve(config.dataDir, "search.sqlite"));
	const stopIndexing = harness.subscribeCommits((publication) => {
		const found = publication.changes.flatMap((change) => (change.type === "entry" ? messagesOf({ ...change.value, id: Number(change.value.id), conversationId: Number(change.value.conversationId) }) : []));
		if (found.length === 0) return;
		try {
			searchIndex.add(found);
		} catch (error) {
			console.error(`[search] ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	/** Indexes every session's entries newer than the index has, oldest first; at start, and after a rebuild. */
	async function catchUp(): Promise<number> {
		const from = searchIndex.progress();
		let added = 0;
		let newest = from;
		for (const session of await list()) {
			const found = await harness.conversation(conversationId(session.id), context);
			if (found === undefined) continue;
			let cursor: Parameters<typeof found.entries>[2];
			do {
				const page = await found.entries({ order: "ascending", ...(from > 0 ? { minEntryId: (from + 1) as EntryId } : {}) }, 500, cursor, context);
				const messages = page.items.flatMap((e) => messagesOf({ ...e, id: Number(e.id), conversationId: session.id }));
				searchIndex.add(messages);
				for (const e of page.items) newest = Math.max(newest, Number(e.id));
				added += messages.length;
				cursor = page.next;
			} while (cursor !== undefined);
		}
		searchIndex.advance(newest);
		return added;
	}
	const caughtUp = catchUp().then(
		(added) => {
			if (added > 0) console.error(`[search] indexed ${added} messages`);
		},
		(error) => console.error(`[search] catching up: ${error instanceof Error ? error.message : String(error)}`),
	);

	/** Messages and answers matching `query`, best first, each with its session's record; archived sessions included. */
	async function searchMessages(query: string, options: { session?: number; limit?: number } = {}) {
		await caughtUp;
		const sessions = new Map((await list()).map((s) => [s.id, s]));
		return searchIndex.search(query, { ...options, limit: (options.limit ?? 50) * 2 })
			.flatMap((hit) => {
				const session = sessions.get(hit.session);
				if (session === undefined) return [];
				return [{ ...hit, title: session.title, project: session.project, workspace: session.workspace, ...(session.archived === true ? { archived: true } : {}) }];
			})
			.slice(0, options.limit ?? 50);
	}

	async function list(): Promise<SessionRecord[]> {
		const doc = await harness.snapshot(Sessions, context);
		return Object.values(doc?.sessions ?? {}).map((s) => ({ ...s })).sort((a, b) => a.id - b.id);
	}

	async function get(id: number): Promise<SessionRecord | undefined> {
		const doc = await harness.snapshot(Sessions, context);
		const found = doc?.sessions[String(id)];
		return found === undefined ? undefined : { ...found };
	}

	/** The pinned models: the settings' choices their providers have, or the one model given. */
	function choices(): ModelChoice[] {
		const refs: ModelRef[] = options.models === undefined ? config.model.choices.map((c) => ({ provider: c.provider, modelId: c.id })) : [model];
		return refs.flatMap((ref) => {
			const found = models.getModel(ref.provider, ref.modelId);
			return found === undefined ? [] : [choiceOf(ref.provider, found)];
		});
	}

	const catalog = createCatalog(models);

	/** A model's name and context window; an unknown model gets its ID and no window. */
	function modelInfo(ref: ModelRef): { name: string; window: number } {
		const found = models.getModel(ref.provider, ref.modelId);
		return found === undefined ? { name: ref.modelId, window: 0 } : { name: displayName(found.name), window: found.contextWindow };
	}

	/**
	 * The model `name` names: a pinned choice's ID, or `provider/id` for any model a provider has, such as
	 * openrouter/anthropic/claude-opus-5.5. Throws for one there's no such model.
	 */
	function choose(name: string | undefined): ModelRef | undefined {
		if (name === undefined) return undefined;
		const pinned = choices().find((c) => c.id === name);
		if (pinned !== undefined) return { provider: pinned.provider, modelId: pinned.id };
		const slash = name.indexOf("/");
		const provider = name.slice(0, slash);
		const modelId = name.slice(slash + 1);
		if (slash > 0 && models.getProvider(provider) !== undefined && models.getModel(provider, modelId) !== undefined) return { provider, modelId };
		throw new Error(`no model ${name} to choose`);
	}

	/** A new session in `project`, titled from `prompt`, with the default model and thinking unless `agent` names others. */
	async function create(project: Project, prompt: string, agent: { model?: string; thinking?: Thinking } = {}): Promise<SessionRecord> {
		let record: SessionRecord | undefined;
		const base = await snapshot(project.dir);
		await harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: choose(agent.model) ?? model, thinkingLevel: agent.thinking ?? config.model.thinking, cwd: project.dir },
			init: async (tx, id) => {
				record = {
					id,
					workspace: project.workspace,
					project: project.name,
					dir: project.dir,
					title: prompt.split("\n")[0]!.slice(0, 80),
					createdAt: Date.now(),
					...("error" in base ? { baseError: base.error } : { base }),
				};
				(await tx.doc(Sessions)).sessions[String(id)] = record;
			},
		}, context);
		untitled.add(record!.id);
		for (const listener of created) listener(record!);
		return record!;
	}

	/**
	 * A session in no project: its working directory is a scratch directory of its own, `scratch/<id>` in the data
	 * directory, which the agent makes files in; it reads anything else by absolute path. No changes view: nothing to
	 * compare against.
	 */
	async function createScratch(prompt: string, agent: { model?: string; thinking?: Thinking } = {}): Promise<SessionRecord> {
		let record: SessionRecord | undefined;
		await harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: choose(agent.model) ?? model, thinkingLevel: agent.thinking ?? config.model.thinking },
			init: async (tx, id) => {
				const dir = resolve(scratchRoot, String(id));
				// The conversation's ID names its directory, so the working directory is set in the creating commit.
				await configureAgent(tx, id, { cwd: dir });
				record = {
					id,
					workspace: config.workspaces[0]?.name ?? "local",
					project: NO_PROJECT,
					dir,
					title: prompt.split("\n")[0]!.slice(0, 80),
					createdAt: Date.now(),
					baseError: "A no-project session has no project to compare against.",
					scratch: true,
				};
				(await tx.doc(Sessions)).sessions[String(id)] = record;
			},
		}, context);
		mkdirSync(record!.dir, { recursive: true, mode: 0o700 });
		untitled.add(record!.id);
		for (const listener of created) listener(record!);
		return record!;
	}

	/** Calls `listener` with each session created from now on. */
	function onCreate(listener: (session: SessionRecord) => void): () => void {
		created.add(listener);
		return () => created.delete(listener);
	}

	const updated = new Set<(session: SessionRecord) => void>();

	/** Sessions made in this process whose first message hasn't come yet; it's what their title is written from. */
	const untitled = new Set<number>();

	/**
	 * Has the titler write session `id`'s title from `text`, its first message, unless someone renamed it meanwhile.
	 * Resolves with the new record, or undefined when nothing changed; never rejects.
	 */
	async function writeTitle(id: number, text: string): Promise<SessionRecord | undefined> {
		if (titler === undefined || text.trim() === "") return undefined;
		try {
			const title = await titler(text);
			if (title === undefined) return undefined;
			const record = await root.commit(async (tx) => {
				const found = (await tx.doc(Sessions)).sessions[String(id)];
				if (found === undefined || found.titled === "user") return undefined;
				found.title = title;
				found.titled = "model";
				return { ...found };
			}, context);
			if (record !== undefined) updated.forEach((listener) => listener(record));
			return record;
		} catch (error) {
			console.error(`[titles] session ${id}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/** The text of session `id`'s first message, or undefined if it has none. */
	async function firstMessage(id: number): Promise<string | undefined> {
		const state = await (await conversation(id)).viewState(context);
		try {
			const first = itemsOf(state.value).find((item) => item.kind === "user");
			return first?.kind === "user" ? first.text : undefined;
		} finally {
			state.dispose();
		}
	}

	/**
	 * Writes titles for sessions that still have their first message's first line, oldest first, and calls `onEach` with
	 * each one done. Sessions renamed before titles were tracked are told apart by a title that isn't that first line.
	 */
	async function retitle(onEach: (before: SessionRecord, after: SessionRecord | undefined) => void = () => {}): Promise<void> {
		for (const session of await list()) {
			if (session.titled !== undefined) continue;
			const text = await firstMessage(session.id);
			if (text === undefined) continue;
			const fromText = [text.split("\n")[0]!.slice(0, 80), text.split("\n").find((l) => l.trim() !== "")?.trim().slice(0, 80)];
			if (!fromText.includes(session.title)) continue;
			onEach(session, await writeTitle(session.id, text));
		}
	}

	/**
	 * Has a model write session `id`'s title again, from the whole conversation as it is now, replacing any title, one set
	 * by hand too. A rename made while the model writes wins. Resolves with the new record, or undefined when no model
	 * wrote one; throws if there's no such session or it has no messages yet.
	 */
	async function regenerateTitle(id: number): Promise<SessionRecord | undefined> {
		const before = await get(id);
		if (before === undefined) throw new Error(`no session ${id}`);
		const state = await (await conversation(id)).viewState(context);
		let exchanges: Exchange[];
		try {
			exchanges = itemsOf(state.value).flatMap((item): Exchange[] =>
				item.kind === "user" ? [{ from: "user", text: withoutFileNotes(withoutVideoNotes(item.text)) }] : item.kind === "answer" && item.streaming !== true ? [{ from: "agent", text: item.text }] : [],
			);
		} finally {
			state.dispose();
		}
		if (!exchanges.some((e) => e.from === "user" && e.text.trim() !== "")) throw new ParseError("the session has no messages to title it from");
		if (titler === undefined) return undefined;
		const title = await titler(excerptOf(exchanges), { conversation: true });
		if (title === undefined) return undefined;
		const record = await root.commit(async (tx) => {
			const found = (await tx.doc(Sessions)).sessions[String(id)];
			if (found === undefined) return undefined;
			if (found.titled === "user" && found.title !== before.title) return undefined;
			found.title = title;
			found.titled = "model";
			return { ...found };
		}, context);
		if (record !== undefined) updated.forEach((listener) => listener(record));
		return record;
	}

	/** Gives session `id` a new title; returns its record, or throws if there's no such session. */
	async function rename(id: number, title: string): Promise<SessionRecord> {
		const trimmed = title.replace(/\s+/g, " ").trim();
		// ParseErrors, since they're about what was asked: the API answers them with 400.
		if (trimmed === "") throw new ParseError("a title needs some text");
		if (trimmed.length > 200) throw new ParseError("a title is at most 200 characters");
		const record = await root.commit(async (tx) => {
			const doc = await tx.doc(Sessions);
			const found = doc.sessions[String(id)];
			if (found === undefined) throw new Error(`no session ${id}`);
			found.title = trimmed;
			found.titled = "user";
			return { ...found };
		}, context);
		updated.forEach((listener) => listener(record));
		return record;
	}

	/** Archives session `id`, or brings it back with false; returns its record. Archiving only hides it from the lists. */
	async function archive(id: number, archived: boolean): Promise<SessionRecord> {
		const record = await root.commit(async (tx) => {
			const found = (await tx.doc(Sessions)).sessions[String(id)];
			if (found === undefined) throw new Error(`no session ${id}`);
			if (archived) found.archived = true;
			else delete found.archived;
			return { ...found };
		}, context);
		updated.forEach((listener) => listener(record));
		return record;
	}

	/** Hears of a session record that changed after it was made, such as a new title. */
	function onUpdate(listener: (session: SessionRecord) => void): () => void {
		updated.add(listener);
		return () => updated.delete(listener);
	}

	async function conversation(id: number) {
		const found = await harness.conversation(conversationId(id), context);
		if (found === undefined || (await get(id)) === undefined) throw new Error(`no session ${id}; aludra sessions lists them`);
		return found;
	}

	/** Sends `content` to session `id`. A busy session queues it as a follow-up, or as a steer. */
	async function submit(id: number, content: UserMessage["content"], options: { requestId?: string; steer?: boolean } = {}) {
		const target = await conversation(id);
		// A new message instead of an answer: the waiting call is refused, so the run can take the message.
		await approvals!.supersede(id);
		// Text too long for a message goes to a file the message points at, unless this is a retry of one already sent.
		if (!(await sent(id, options.requestId))) content = await movedLongText(id, content);
		// A new session's first message names it, in the background.
		if (untitled.delete(id)) void writeTitle(id, withoutFileNotes(withoutVideoNotes(textOf(content))));
		// After a restore, the next message tells the agent the files were put back.
		const note = await checkpoints.takeNote(id);
		if (note !== undefined) content = [{ type: "text", text: restoreNoteText(note) }, ...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content)];
		return target.submit({ type: "input", content, whenBusy: options.steer ? "steer" : "followUp", ...(options.requestId === undefined ? {} : { requestId: options.requestId }) }, context);
	}

	/** Whether a message with `requestId` was already sent to session `id`: a retry, whose files mustn't be saved again. */
	async function sent(id: number, requestId: string | undefined): Promise<boolean> {
		if (requestId === undefined) return false;
		return (await harness.commit((tx) => tx.submissionByRequest(conversationId(id), requestId), context)) !== undefined;
	}

	/** `content` with a text block over PASTE_BYTES saved to a file: the message keeps its start and a note (src/files.ts). */
	async function movedLongText(id: number, content: UserMessage["content"]): Promise<UserMessage["content"]> {
		const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
		const long = blocks.findIndex((b) => b.type === "text" && isLong(b.text));
		if (long === -1) return content;
		const text = (blocks[long] as TextContent).text;
		const notes = fileBlocks(await saveFiles(uploads, id, [], text));
		return [...blocks.slice(0, long), { type: "text", text: preview(text) }, ...notes, ...blocks.slice(long + 1)];
	}

	/** Saves checked files for session `id`; returns what its message carries for them (src/files.ts). */
	async function files(id: number, inputs: readonly FileInput[]) {
		return fileBlocks(await saveFiles(uploads, id, inputs));
	}

	/** Saves checked videos for session `id`; returns what its message carries for them (src/videos.ts). */
	async function videos(id: number, inputs: readonly VideoInput[]) {
		return videoBlocks(await saveVideos(uploads, id, inputs));
	}

	/** The image at block `block` of message `message` in entry `entry` of session `id`, or undefined if there's none. */
	async function image(id: number, entry: number, message: number, block: number): Promise<ImageInput | undefined> {
		const read = async (cid: ConversationId, eid: EntryId) => {
			const found = await harness.conversation(cid, context);
			return found === undefined ? undefined : (await found.entries({ minEntryId: eid, maxEntryId: eid }, 1, undefined, context)).items[0];
		};
		// SAFETY: entry IDs are the numbers Pi Durable gave out, or numbers from the user that are only looked up.
		return readImage(read, conversationId(id), entry as EntryId, message, block);
	}

	const colorListeners = new Set<(colors: Record<string, number>) => void>();

	/** The picked project colors: name to hue index. */
	async function listColors(): Promise<Record<string, number>> {
		return { ...(await harness.snapshot(Colors, context))?.colors };
	}

	/** Gives `project` hue `color`, or its own hashed one again with null. */
	async function setColor(project: string, color: number | null): Promise<Record<string, number>> {
		// ParseErrors, since they're about what was asked: the API answers them with 400.
		if (project.trim() === "") throw new ParseError("a color needs a project name");
		if (color !== null && !(Number.isInteger(color) && color >= 0 && color < PROJECT_HUES)) throw new ParseError(`a color is a hue from 0 to ${PROJECT_HUES - 1}`);
		const colors = await root.commit(async (tx) => {
			const doc = await tx.doc(Colors);
			if (color === null) delete doc.colors[project];
			else doc.colors[project] = color;
			return { ...doc.colors };
		}, context);
		colorListeners.forEach((listener) => listener(colors));
		return colors;
	}

	function onColors(listener: (colors: Record<string, number>) => void): () => void {
		colorListeners.add(listener);
		return () => void colorListeners.delete(listener);
	}

	const ideaListeners = new Set<() => void>();
	const ideasChanged = () => ideaListeners.forEach((listener) => listener());

	/** Ideas, newest first. */
	async function listIdeas(): Promise<IdeaRecord[]> {
		const doc = await harness.snapshot(Ideas, context);
		return Object.values(doc?.ideas ?? {}).map((i) => ({ ...i })).sort((a, b) => b.createdAt - a.createdAt);
	}

	async function addIdea(project: Project, text: string): Promise<IdeaRecord> {
		const trimmed = text.trim();
		if (trimmed === "") throw new Error("an idea needs some text");
		const idea = await root.commit(async (tx) => {
			const doc = await tx.doc(Ideas);
			const record: IdeaRecord = { id: doc.next, workspace: project.workspace, project: project.name, dir: project.dir, text: trimmed, createdAt: Date.now() };
			doc.next += 1;
			doc.ideas[String(record.id)] = record;
			return { ...record };
		}, context);
		ideasChanged();
		return idea;
	}

	/** Drops idea `id`; returns it, or nothing if there's none. */
	async function removeIdea(id: number): Promise<IdeaRecord | undefined> {
		const removed = await root.commit(async (tx) => {
			const doc = await tx.doc(Ideas);
			const found = doc.ideas[String(id)];
			if (found === undefined) return undefined;
			const copy = { ...found };
			delete doc.ideas[String(id)];
			return copy;
		}, context);
		if (removed !== undefined) ideasChanged();
		return removed;
	}

	/** Starts idea `id` as a session in its project, and drops it once the session has its message. */
	async function startIdea(id: number): Promise<SessionRecord> {
		const idea = (await listIdeas()).find((i) => i.id === id);
		if (idea === undefined) throw new Error(`no idea ${id}`);
		const project = projects().find((p) => p.dir === idea.dir) ?? { workspace: idea.workspace, name: idea.project, path: idea.project, dir: idea.dir };
		const session = await create(project, idea.text);
		await submit(session.id, idea.text, { requestId: `idea:${id}` });
		await removeIdea(id);
		return session;
	}

	function onIdeas(listener: () => void): () => void {
		ideaListeners.add(listener);
		return () => ideaListeners.delete(listener);
	}

	/** Changes session `id`'s model or thinking; the next request uses them. */
	async function configure(id: number, change: { model?: string; thinking?: Thinking }): Promise<void> {
		const target = await conversation(id);
		const chosen = choose(change.model);
		await target.configure({ ...(chosen === undefined ? {} : { model: chosen }), ...(change.thinking === undefined ? {} : { thinkingLevel: change.thinking }) }, context);
	}

	/** Takes back a message queued in session `id` before the run reaches it. */
	async function withdraw(id: number, submission: number): Promise<"aborted" | "already_placed" | "settled" | "not_found"> {
		const target = await conversation(id);
		// SAFETY: a submission ID Pi Durable gave out, or a number from the user that's only looked up in this conversation.
		return harness.abortSubmission(submission as Parameters<Harness["abortSubmission"]>[0], context, target.id);
	}

	/** Stops session `id`'s run. */
	async function stop(id: number | ConversationId): Promise<void> {
		await (await conversation(id)).abort(context);
	}

	const settingListeners = new Set<() => void>();

	/** The settings as clients see them (src/settings.ts). */
	const readSettings = (): Settings => describeSettings(config.file, config);

	/**
	 * Saves `changes` to the settings file and applies what this host can take while it runs: everything clients can
	 * change, except a default or pinned model of a provider it didn't load (Claude Code when no Claude model was pinned
	 * at start), which waits for a restart. A model of a loaded provider has to be one it has.
	 */
	function saveSettings(changes: { readonly [key: string]: Json }): Settings {
		const { text, config: next } = changeSettings(config.file, changes);
		const loaded = (provider: string) => models.getProvider(provider) !== undefined;
		const { provider, id } = next.model;
		const moved = provider !== config.model.provider || id !== config.model.id;
		if (moved && loaded(provider) && models.getModel(provider, id) === undefined) throw new SettingsError([`${provider}/${id} isn't a model this host has; the model picker lists them`]);
		writeSettings(config.file!, text);
		config.workspaces = next.workspaces;
		config.approvals = next.approvals;
		config.backup = next.backup;
		config.model.thinking = next.model.thinking;
		if (moved && loaded(provider)) {
			config.model.provider = provider;
			config.model.id = id;
			model = { provider, modelId: id };
		}
		if (next.model.choices.every((c) => loaded(c.provider))) config.model.choices = next.model.choices;
		settingListeners.forEach((listener) => listener());
		return readSettings();
	}

	/** Hears of every saved change to the settings. */
	function onSettings(listener: () => void): () => void {
		settingListeners.add(listener);
		return () => settingListeners.delete(listener);
	}

	/** Each session's state: running while a task of it is live, waiting while a call of it waits for the user. */
	async function states(): Promise<Map<number, "running" | "waiting" | "idle">> {
		const live = new Set((await harness.inspect(context)).tasks.map((t) => Number(t.record.conversationId)));
		const waiting = new Set((await approvals!.pending()).map((r) => r.conversationId));
		const result = new Map<number, "running" | "waiting" | "idle">();
		for (const session of await list()) result.set(session.id, waiting.has(session.id) ? "waiting" : live.has(session.id) ? "running" : "idle");
		return result;
	}

	return {
		harness,
		root,
		approvals,
		/** The default model and thinking of new sessions; the settings can change them while the host runs. */
		get model(): ModelRef {
			return model;
		},
		get thinking(): Thinking {
			return config.model.thinking;
		},
		settings: { get: readSettings, set: saveSettings, onChange: onSettings },
		choices,
		/** Whether `provider` has model `id`. */
		hasModel: (provider: string, id: string) => models.getProvider(provider) !== undefined && models.getModel(provider, id) !== undefined,
		/** Every model a session can run on, by provider (src/catalog.ts). */
		catalog: () => catalog.list(),
		modelInfo,
		projects,
		sessions: { list, get, create, createScratch, onCreate, rename, retitle, regenerateTitle, archive, onUpdate, states },
		checkpoints: {
			list: checkpoints.list,
			changes: checkpoints.changes,
			diff: checkpoints.diff,
			/** Puts session `id`'s project back to a checkpoint; refused while it runs or waits. */
			restore: async (id: number, checkpoint: number) => {
				const state = (await states()).get(id);
				if (state === undefined) throw new Error(`no session ${id}`);
				const result = await checkpoints.restore(id, checkpoint, state !== "idle");
				const record = await get(id);
				if (record !== undefined) updated.forEach((listener) => listener(record));
				return result;
			},
		},
		scratchRoot,
		uploads,
		ideas: { list: listIdeas, add: addIdea, remove: removeIdea, start: startIdea, onChange: onIdeas },
		colors: { list: listColors, set: setColor, onChange: onColors },
		conversation,
		submit,
		image,
		videos,
		files,
		sent,
		configure,
		withdraw,
		stop,
		/** Continues the work the last process left unfinished. */
		resume: () => harness.resume(),
		search: searchMessages,
		/** Empties the search index and builds it again from every session. */
		reindex: async () => {
			await caughtUp;
			searchIndex.reset();
			return catchUp();
		},
		close: async () => {
			clearInterval(sweeper);
			stopIndexing();
			await caughtUp;
			await harness.close(context);
			searchIndex.close();
		},
	};
}

export type Host = Awaited<ReturnType<typeof openHost>>;
