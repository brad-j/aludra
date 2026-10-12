// The host: one Pi Durable Harness over SQLite in the data directory. Each session is an ownerless conversation whose
// agent `cwd` is its project's directory; the root conversation only carries aludra's session-wide documents.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type CompactionPolicy, type ConversationId, createRegistry, defineDoc, Harness, type Extension, type ModelRef, ProviderDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ModelChoice } from "./api-types.ts";
import { type Bridge, bridgeProvider, loadBridge, type Notice, PROVIDER } from "./bridge.ts";
import type { Config, Thinking } from "./config.ts";
import { AGENT_DIR, contextExtension } from "./context.ts";
import { ApprovalService, permissionsExtension } from "./permissions.ts";
import { findProjects, type Project } from "./projects.ts";

export const context = BACKGROUND_CONTEXT;

export type SessionRecord = {
	id: number;
	workspace: string;
	project: string;
	dir: string;
	/** The first line of the first message. */
	title: string;
	createdAt: number;
};

/** Something to do later: a first message, filed under its project, not sent yet. */
export type IdeaRecord = { id: number; workspace: string; project: string; dir: string; text: string; createdAt: number };

export const Ideas = defineDoc<{ next: number; ideas: Record<string, IdeaRecord> }>({
	kind: "aludra.ideas",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, ideas: {} }),
});

export const Sessions = defineDoc<{ sessions: Record<string, SessionRecord> }>({
	kind: "aludra.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
});

/** "Claude Opus 5.5 1M" as "Opus 5.5". */
export const displayName = (name: string) => name.replace(/^Claude /, "").replace(/ (1M|\(latest\))$/, "");

export function conversationId(id: number): ConversationId {
	// SAFETY: a session's id is the id Pi Durable gave its conversation, or a number from Brad that's only looked up.
	return id as ConversationId;
}

/** What the faux model answers a message asking for "markdown": enough to check how answers render. */
const FAUX_MARKDOWN = [
	"Here's what changed, in **three** parts:",
	"",
	"1. `src/api.ts` serves the app and its API.",
	"2. The socket sends each session's transcript as it grows.",
	"3. Approvals answer over HTTP.",
	"",
	"```ts",
	"const server = createApi(host, { user });",
	"server.listen(8724);",
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
 * asking for "markdown" gets FAUX_MARKDOWN, one saying "push" runs `git push --dry-run` (which waits for approval), and
 * any other request calls bash once, with a sleep long enough to kill the process during it.
 */
function fauxModels(): { models: Models; model: ModelRef } {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	faux.setResponses(Array.from({ length: 1000 }, () => (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`Tool came back: ${JSON.stringify(last.content)}`));
		if (/markdown/i.test(JSON.stringify(last?.content))) return fauxAssistantMessage(fauxText(FAUX_MARKDOWN));
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
	/** The bridge in place of pi-claude-bridge; tests pass a fake. */
	bridge?: Bridge;
	/** Where AGENTS.md and skills are looked for besides the project. Default: ~/.pi/agent. */
	agentDir?: string;
	/** What the bridge would show in pi's UI, such as rate-limit warnings. Default: the host's stderr. */
	onNotice?: (notice: Notice) => void;
	/** Over Pi Durable's compaction defaults; the live check keeps less so a small conversation compacts. */
	compaction?: Partial<CompactionPolicy>;
};

export async function openHost(options: HostOptions) {
	const { config } = options;
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const thinkingLevel: Thinking = config.model.thinking;
	const notify = options.onNotice ?? ((notice: Notice) => console.error(`[bridge ${notice.level}] ${notice.message}`));

	let models: Models;
	let model: ModelRef;
	const extensions: Extension[] = [CodingTools, contextExtension(options.agentDir ?? AGENT_DIR)];
	let bridged: ReturnType<typeof bridgeProvider> | undefined;
	if (options.models !== undefined && options.model !== undefined) {
		models = options.models;
		model = options.model;
	} else if (config.model.provider === "faux" && options.bridge === undefined) {
		({ models, model } = fauxModels());
	} else {
		bridged = bridgeProvider(options.bridge ?? (await loadBridge(notify)));
		const mutable = createModels();
		mutable.setProvider(bridged.provider);
		models = mutable;
		model = { provider: PROVIDER, modelId: config.model.id };
		extensions.push(bridged.extension);
		if (models.getModel(PROVIDER, model.modelId) === undefined) throw new Error(`pi-claude-bridge has no model ${model.modelId}`);
	}

	let approvals: ApprovalService | undefined;
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	// Last, so it wraps the tools the others bring, and other hooks see a call before it waits for Brad.
	registry.install(permissionsExtension({ approvals: () => approvals!, hosts: config.approvals.hosts }));

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
	approvals = new ApprovalService(harness, config.approvals.waitHours * 3_600_000);
	const root = await harness.root(context);
	const created = new Set<(session: SessionRecord) => void>();

	const projects = (): Project[] => findProjects(config.workspaces);

	async function list(): Promise<SessionRecord[]> {
		const doc = await harness.snapshot(Sessions, context);
		return Object.values(doc?.sessions ?? {}).map((s) => ({ ...s })).sort((a, b) => a.id - b.id);
	}

	async function get(id: number): Promise<SessionRecord | undefined> {
		const doc = await harness.snapshot(Sessions, context);
		const found = doc?.sessions[String(id)];
		return found === undefined ? undefined : { ...found };
	}

	/** The models sessions can use: the settings' choices the provider has, or the one model given. */
	function choices(): ModelChoice[] {
		const ids = options.models === undefined ? config.model.choices : [model.modelId];
		return ids.flatMap((id) => {
			const found = models.getModel(model.provider, id);
			return found === undefined ? [] : [{ provider: model.provider, id, name: displayName(found.name) }];
		});
	}

	/** A model's name and context window; an unknown model gets its ID and no window. */
	function modelInfo(ref: ModelRef): { name: string; window: number } {
		const found = models.getModel(ref.provider, ref.modelId);
		return found === undefined ? { name: ref.modelId, window: 0 } : { name: displayName(found.name), window: found.contextWindow };
	}

	function choose(modelId: string | undefined): ModelRef | undefined {
		if (modelId === undefined) return undefined;
		const choice = choices().find((c) => c.id === modelId);
		if (choice === undefined) throw new Error(`no model ${modelId} to choose`);
		return { provider: choice.provider, modelId: choice.id };
	}

	/** A new session in `project`, titled from `prompt`, with the default model and thinking unless `agent` names others. */
	async function create(project: Project, prompt: string, agent: { model?: string; thinking?: Thinking } = {}): Promise<SessionRecord> {
		let record: SessionRecord | undefined;
		await harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: choose(agent.model) ?? model, thinkingLevel: agent.thinking ?? thinkingLevel, cwd: project.dir },
			init: async (tx, id) => {
				record = { id, workspace: project.workspace, project: project.name, dir: project.dir, title: prompt.split("\n")[0]!.slice(0, 80), createdAt: Date.now() };
				(await tx.doc(Sessions)).sessions[String(id)] = record;
			},
		}, context);
		for (const listener of created) listener(record!);
		return record!;
	}

	/** Calls `listener` with each session created from now on. */
	function onCreate(listener: (session: SessionRecord) => void): () => void {
		created.add(listener);
		return () => created.delete(listener);
	}

	async function conversation(id: number) {
		const found = await harness.conversation(conversationId(id), context);
		if (found === undefined || (await get(id)) === undefined) throw new Error(`no session ${id}; aludra sessions lists them`);
		return found;
	}

	/** Sends `content` to session `id`. A busy session queues it as a follow-up, or as a steer. */
	async function submit(id: number, content: string, options: { requestId?: string; steer?: boolean } = {}) {
		const target = await conversation(id);
		// A new message instead of an answer: the waiting call is refused, so the run can take the message.
		await approvals!.supersede(id);
		return target.submit({ type: "input", content, whenBusy: options.steer ? "steer" : "followUp", ...(options.requestId === undefined ? {} : { requestId: options.requestId }) }, context);
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
		// SAFETY: a submission ID Pi Durable gave out, or a number from Brad that's only looked up in this conversation.
		return harness.abortSubmission(submission as Parameters<Harness["abortSubmission"]>[0], context, target.id);
	}

	/** Stops session `id`'s run, and its Claude Code query if one is open between requests. */
	async function stop(id: number | ConversationId): Promise<void> {
		const target = await conversation(id);
		await target.abort(context);
		const session = await harness.snapshot(ProviderDoc, target.id, context);
		if (session !== undefined) bridged?.abort(session.sessionId);
	}

	/** Each session's state: running while a task of it is live, waiting while a call of it waits for Brad. */
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
		model,
		thinking: thinkingLevel,
		choices,
		modelInfo,
		projects,
		sessions: { list, get, create, onCreate, states },
		ideas: { list: listIdeas, add: addIdea, remove: removeIdea, start: startIdea, onChange: onIdeas },
		conversation,
		submit,
		configure,
		withdraw,
		stop,
		/** Continues the work the last process left unfinished. */
		resume: () => harness.resume(),
		close: () => harness.close(context),
	};
}

export type Host = Awaited<ReturnType<typeof openHost>>;
