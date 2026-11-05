// The host: one Pi Durable Harness over SQLite in the data directory. Each session is an ownerless conversation whose
// agent `cwd` is its project's directory; the root conversation only carries aludra's session-wide documents.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { type CompactionPolicy, configure as configureAgent, type ConversationId, type DocumentReader, createRegistry, defineDoc, defineDocFamily, defineExtension, type EntryId, Harness, hook, type Extension, type JsonObject, type ModelRef, ToolTask } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createSandboxes, deleteBranch, run, run as runCommand, type Sandboxes, fastForward, type MergeResult, type SandboxSize, type SandboxStep, type SyncResult } from "./sandboxes.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ModelChoice, Settings } from "./api-types.ts";
import { claudeCodeProvider, loadClaudeCode, PROVIDER } from "./claude-code.ts";
import { choiceOf, createCatalog, displayName } from "./catalog.ts";
import { credentialsFile, fileCredentialStore } from "./credentials.ts";
import { type Snapshot, snapshot } from "./changes.ts";
import { createCheckpoints, restoreNoteText } from "./checkpoints.ts";
import { pagesExtension } from "./pages.ts";
import { claudeConfigDir, type Config, expandHome, type Thinking } from "./config.ts";
import { type ImageInput, readImage } from "./images.ts";
import { AGENT_DIR, contextExtension, type Place } from "./context.ts";
import { ApprovalService, permissionsExtension } from "./permissions.ts";
import { askSession, createShips, type ShipLanded, type Shipping, shipOutcome, type ShipStopped, shipTimeout } from "./ship.ts";
import { createResults, parseProjectConfig, TurnChecks } from "./results.ts";
import { readShot } from "./shots.ts";
import { HUES } from "./project-colors.ts";
import { findProjects, type Project } from "./projects.ts";
import { createNewProjects, ghProblem, NewProjectRefused, type NewProjectsOptions } from "./new-projects.ts";
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
	/** Brought back from the archive by hand, so it isn't archived again for being idle (src/archive.ts). */
	kept?: boolean;
	createdAt: number;
	/** The project's files when it started, for its changes (src/changes.ts); or why there's no snapshot. */
	base?: Snapshot;
	baseError?: string;
	/**
	 * A no-project session: `project` is NO_PROJECT. Here, `dir` is its own scratch directory; in a sandbox, `source` is a
	 * repository of its own in the scratch directory, which its work comes home to (scratchRepository).
	 */
	scratch?: boolean;
	/**
	 * A sandbox session (spike): its tools run on this sandbox, by its number on the sandbox host, and `dir` is a directory
	 * there. Unset while the sandbox is being made.
	 */
	sandbox?: number;
	/**
	 * A sandbox session's own number, which names its branch, `sandbox/<number>`: given out by aludra, one count across
	 * projects, never reused. The sandbox host reuses its numbers, so they can't name branches. Sessions from before it
	 * have none, and their branch is `sandbox/<sandbox>`.
	 */
	sandboxNumber?: number;
	/** Where its sandbox is: being made, ready, or failed to be made (`sandboxReason` says why). Unset is ready. */
	sandboxState?: "preparing" | "ready" | "failed";
	/** While preparing, what's being done. */
	sandboxStep?: SandboxStep;
	sandboxReason?: string;
	/** The project's commit its sandbox was made from. */
	sandboxBase?: string;
	/** A sandbox session's approvals: `ask` waits for them as any session does, `off` doesn't. Unset follows `sandboxes.approvals`. */
	approvals?: "ask" | "off";
	/** Its sandbox/N was discarded: archiving deletes the sandbox without fetching it again. A sync clears it. */
	sandboxDiscarded?: boolean;
	/** A ship going on (src/ship.ts), so a restart finishes it. */
	shipping?: Shipping;
	/** The latest ship that landed, kept until another lands. */
	shipped?: ShipLanded;
	/** The latest ship that stopped short, cleared when the next one starts or lands. */
	shipStopped?: ShipStopped;
	/** Sessions made with the same group are attempts at one ask (amyrlin's ×3). */
	group?: string;
	/** A sandbox session's size: asked for when it was made, else the project's (.agents/project.json), set once known. */
	sandboxSize?: SandboxSize;
	/** A sandbox session's project directory on this machine, which its template was made from; context is read there. */
	source?: string;
	/** Its sandbox was deleted (src/sandbox-cleanup.ts): its tools have nowhere to run. */
	sandboxRemoved?: boolean;
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

/** Messages a sandbox session got while its sandbox was being made, by session, each its content's JSON; sent in order once it's ready. */
export const Held = defineDocFamily<{ messages: { content: string; requestId: string }[] }, null>({
	kind: "aludra.held",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ messages: [] }),
});

/** The next sandbox session number (SessionRecord.sandboxNumber). */
const SandboxNumbers = defineDoc<{ next: number }>({
	kind: "aludra.sandbox-numbers",
	version: 1,
	scope: "session",
	initial: () => ({ next: 0 }),
});

/** The name a scratch sandbox's repository goes by: its template's and its directory's in the sandbox. */
export const SCRATCH_NAME = "scratch";

/**
 * Makes `dir` a repository whose `main` is one empty commit, the same commit every time for this machine's git identity
 * (its dates are fixed), so every scratch sandbox shares one template. Leaves one that's already there.
 */
export async function scratchRepository(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const git = (...args: string[]) => run("git", ["-C", dir, ...args]);
	const head = (await git("rev-parse", "--verify", "--quiet", "refs/heads/main").catch(() => "")).trim();
	if (head !== "") return head;
	await git("init", "-q", "-b", "main");
	const who = async (key: string, fallback: string) => (await git("config", "--get", key).catch(() => "")).trim() || fallback;
	const name = await who("user.name", "aludra");
	const email = await who("user.email", "aludra@localhost");
	const when = "2026-01-01T00:00:00Z";
	const tree = (await git("write-tree")).trim();
	const commit = (await runEnv("git", ["-C", dir, "commit-tree", tree, "-m", "Scratch"], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: when })).trim();
	await git("update-ref", "refs/heads/main", commit);
	return commit;
}

/** Runs `cmd` with `env` over this process's environment. */
function runEnv(cmd: string, args: readonly string[], env: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => (error ? reject(new Error(`${cmd}: ${stderr.trim() || error.message}`)) : resolve(stdout)));
	});
}

/** A sandbox session's branch in its project's checkout. */
export function sandboxBranch(record: Pick<SessionRecord, "sandbox" | "sandboxNumber">): string {
	return `sandbox/${record.sandboxNumber ?? record.sandbox}`;
}

/** Whether `record` is a sandbox session, its sandbox made or not. */
export const isSandboxSession = (record: SessionRecord | undefined) => record !== undefined && (record.sandbox !== undefined || record.sandboxNumber !== undefined);

/** A message to a sandbox session that has no sandbox yet, or whose sandbox couldn't be made. */
export class SandboxNotReady extends Error {}

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
	/** Sandboxes in place of the settings' sandbox host; tests pass ones over pi-env's local daemon. */
	sandboxes?: Sandboxes;
	/** Writes sessions' titles. Default: the smallest model on hand (src/titles.ts); none for the faux model, given models or a given Claude Code provider. */
	titler?: Titler;
	/** gh, and the remote a new project pushes to, in place of the real ones (src/new-projects.ts); tests pass fakes. */
	newProjects?: Pick<NewProjectsOptions, "gh" | "remoteUrl">;
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
	const sandboxOf = async ({ conversationId: id, read }: { conversationId: ConversationId; read: DocumentReader }, ctx: Context = context): Promise<{ sandbox: number; dir: string; branch: string; local?: string; scratch?: true; removed?: true } | { sandbox: undefined; dir: string } | undefined> => {
		const record = (await read.snapshot(Sessions, ctx))?.sessions[String(id)];
		if (record === undefined || !isSandboxSession(record)) return undefined;
		// Being made: nothing may run anywhere yet, here least of all.
		if (record.sandbox === undefined) return { sandbox: undefined, dir: record.dir };
		return { sandbox: record.sandbox, dir: record.dir, branch: sandboxBranch(record), ...(record.source === undefined ? {} : { local: record.source }), ...(record.scratch === true ? { scratch: true as const } : {}), ...(record.sandboxRemoved === true ? { removed: true as const } : {}) };
	};
	const extensions: Extension[] = [CodingTools, contextExtension(agentDir, { scratchRoot: resolve(config.dataDir, "scratch"), places }, async (input) => {
		const found = await sandboxOf(input);
		return found?.sandbox === undefined ? undefined : found;
	})];
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

	/** Whether sandbox session `record`'s tools wait for approvals: its own setting, else the host's. */
	const sandboxApprovals = (record: SessionRecord): "ask" | "off" => record.approvals ?? config.sandboxes?.approvals ?? "off";

	const sandboxDir = resolve(config.dataDir, "sandboxes");
	mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
	const sandboxes = options.sandboxes ?? createSandboxes(config.sandboxes === undefined ? undefined : {
		ssh: config.sandboxes.ssh,
		gateKey: config.sandboxes.gateKey,
		hostKnownHosts: config.sandboxes.knownHosts,
		sandboxKey: config.sandboxes.sandboxKey,
		sandboxHostKey: config.sandboxes.sandboxHostKey,
		dataDir: sandboxDir,
	});
	let approvals: ApprovalService | undefined;
	let opened: Harness | undefined;
	const checkpoints = createCheckpoints({ harness: () => opened!, context, baseOf: async (id) => (await get(id))?.base });
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	registry.install(checkpoints.extension);
	const pages = pagesExtension({ harness: () => opened!, context });
	registry.install(pages.extension);
	// A ship's commands get a timeout, so a check that hangs in the sandbox can't hold the task (src/ship.ts).
	registry.install(defineExtension({
		name: "aludra-ship-timeout",
		hooks: [hook(ToolTask, {
			beforeTool: async (call, api, ctx) => {
				if (call.name !== "bash") return undefined;
				const record = (await api.snapshot(Sessions, ctx))?.sessions[String(api.conversationId)];
				if (record?.shipping === undefined) return undefined;
				const args = shipTimeout(call);
				// SAFETY: the call's own arguments, which are JSON, with a number added.
				return args === undefined ? undefined : { arguments: args as JsonObject };
			},
		})],
	}));
	// Last, so it wraps the tools the others bring, and other hooks see a call before it waits for the user.
	registry.install(permissionsExtension({
		approvals: () => approvals!,
		hosts: () => config.approvals.hosts,
		approvalsOff: async (id, read, ctx) => {
			const record = (await read.snapshot(Sessions, ctx))?.sessions[String(id)];
			return isSandboxSession(record) && sandboxApprovals(record!) === "off";
		},
	}));

	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(config.dataDir, "aludra.sqlite")),
		{
			models,
			registry,
			...(options.compaction === undefined ? {} : { settings: { compaction: options.compaction } }),
			env: async (target, ctx) => {
				const { cwd } = target;
				const sandbox = await sandboxOf(target, ctx);
				// A throw becomes the call's error result, which the model reads.
				if (sandbox !== undefined && sandbox.sandbox === undefined) throw new Error("This session's sandbox isn't ready yet, so its tools have nowhere to run.");
				if (sandbox?.removed === true) throw new Error(`This session's sandbox was deleted when the session was archived, so its tools have nowhere to run. Its commits were fetched to ${sandbox.branch} in the project first. Start a new sandbox session to keep going.`);
				if (sandbox !== undefined) return sandboxes.env(sandbox.sandbox, cwd ?? sandbox.dir);
				return new NodeExecutionEnv({ cwd: cwd ?? homedir() });
			},
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	opened = harness;
	approvals = new ApprovalService(harness, () => config.approvals.waitHours * 3_600_000);
	const root = await harness.root(context);
	const created = new Set<(session: SessionRecord) => void>();

	const projects = (): Project[] => findProjects(config.workspaces);
	/** Set once the host starts closing, so work going on in the background stops writing. */
	let closing = false;

	/** Whether gh can make repositories, read at most once a minute: undefined when it can, else why not. */
	let ghChecked: { at: number; problem: Promise<string | undefined> } | undefined;
	const ghStatus = () => {
		if (ghChecked === undefined || Date.now() - ghChecked.at > 60_000) ghChecked = { at: Date.now(), problem: ghProblem(options.newProjects?.gh) };
		return ghChecked.problem;
	};
	/** Where new projects go and on whose GitHub, when this host can make them now; else why not (src/new-projects.ts). */
	async function newProjectsInfo(): Promise<{ root: string; owner: string } | { reason: string }> {
		if (config.newProjects === undefined) return { reason: "newProjects isn't set" };
		const problem = await ghStatus();
		return problem === undefined ? { ...config.newProjects } : { reason: problem };
	}
	/**
	 * Makes scratch sandbox session `id`'s work a project: its commits, fetched now, become new project `name`'s main, and
	 * the session is then that project's sandbox task, its base the new main, so Ship works from then on. The sandbox's
	 * repository stays where it is, its history already the project's.
	 */
	async function promote(id: number, name: unknown, description?: string): Promise<Project> {
		const record = await get(id);
		if (record === undefined) throw new NewProjectRefused(`no session ${id}`);
		if (record.scratch !== true || !isSandboxSession(record) || record.source === undefined) throw new NewProjectRefused(`session ${id} isn't a scratch sandbox`);
		if (record.sandbox === undefined || record.sandboxRemoved === true) throw new NewProjectRefused(`session ${id}'s sandbox isn't there to take the work from`);
		if (((await states()).get(id) ?? "idle") !== "idle") throw new NewProjectRefused(`session ${id} is running; make it a project once it's done`);
		const synced = await sandboxApi.sync(id);
		if (synced.uncommitted > 0) throw new NewProjectRefused(`the sandbox has ${synced.uncommitted} uncommitted file${synced.uncommitted === 1 ? "" : "s"}; ask the agent to commit first`);
		const project = await createProject(name, description, { source: record.source, ref: `refs/heads/${synced.branch}` });
		const main = (await run("git", ["-C", project.dir, "rev-parse", "main"])).trim();
		const moved = await changeRecord(id, (r) => {
			r.project = project.name;
			r.workspace = project.workspace;
			r.source = project.dir;
			r.sandboxBase = main;
			delete r.scratch;
			delete r.sandboxDiscarded;
		});
		// The branch home is in the project now: sandbox/N there, at the new main.
		await run("git", ["-C", project.dir, "branch", "-f", sandboxBranch(moved ?? record), main]);
		return project;
	}

	/** Makes project `name` in newProjects.root (src/new-projects.ts); the project it is, as the workspaces now list it. */
	async function createProject(name: unknown, description?: string, from?: { source: string; ref: string }): Promise<Project> {
		const info = await newProjectsInfo();
		if ("reason" in info) throw new Error(`this host can't make projects: ${info.reason}`);
		const made = await createNewProjects({ ...info, ...options.newProjects }).create(name, description, from);
		const found = projects().find((p) => p.dir === made.dir);
		if (found === undefined) throw new Error(`${made.dir} was made, but no workspace root lists it`);
		return found;
	}
	/** Where no-project sessions keep the files they make, one directory per session. */
	const scratchRoot = resolve(config.dataDir, "scratch");
	/** Where videos sent with messages are kept, one directory per session, until sweepUploads takes them. */
	const uploads = resolve(config.dataDir, "uploads");
	/** Where sandbox sessions' screenshots are kept, one directory per session, swept with the uploads (src/shots.ts). */
	const shotsDir = resolve(config.dataDir, "shots");
	const sweep = () => {
		for (const dir of [uploads, shotsDir]) void sweepUploads(dir).catch((error) => console.error(`[uploads] ${error instanceof Error ? error.message : String(error)}`));
	};
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

	/** Sandboxes being made, by session; one at a time each. */
	const preparing = new Map<number, Promise<SessionRecord>>();

	/** Commits `change` to session `id`'s record and tells listeners; returns the record, or undefined if there's none. */
	async function changeRecord(id: number, change: (record: SessionRecord) => void): Promise<SessionRecord | undefined> {
		const record = await root.commit(async (tx) => {
			const found = (await tx.doc(Sessions)).sessions[String(id)];
			if (found === undefined) return undefined;
			change(found);
			return { ...found };
		}, context);
		if (record !== undefined) updated.forEach((listener) => listener(record));
		return record;
	}

	/**
	 * A session in a sandbox of its own (spike), made from `project`'s template (src/sandboxes.ts), or a bare sandbox with no
	 * project. Its tools run on the sandbox; its model and transcript stay here. No changes view or checkpoints, which read
	 * files on this machine. Returns at once with the session `preparing`; the sandbox is made after (`prepareSandbox`), and
	 * messages sent meanwhile are held (`hold`) until it's ready.
	 */
	async function startSandbox(project: Project | undefined, prompt: string, agent: { model?: string; thinking?: Thinking } = {}, options: { approvals?: "ask" | "off"; group?: string; size?: SandboxSize; onProgress?: (line: string) => void } = {}): Promise<SessionRecord> {
		if (!sandboxes.configured()) throw new Error("no sandbox host in the settings (sandboxes)");
		// Scratch work gets a repository of its own here, made once its ID is known, which its sandbox's template is cloned from.
		const dir = sandboxes.dirFor({ name: project?.name ?? SCRATCH_NAME, dir: project?.dir ?? scratchRoot });
		// Past any sandbox branch already in the checkout, such as one another data directory made.
		const branches = project === undefined ? "" : await run("git", ["-C", project.dir, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/heads/sandbox/"]).catch(() => "");
		const inCheckout = Math.max(-1, ...branches.split("\n").filter((b) => /^\d+$/.test(b)).map(Number)) + 1;
		let record: SessionRecord | undefined;
		await harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: choose(agent.model) ?? model, thinkingLevel: agent.thinking ?? config.model.thinking, cwd: dir },
			init: async (tx, id) => {
				const numbers = await tx.doc(SandboxNumbers);
				const sessions = (await tx.doc(Sessions)).sessions;
				// Past every sandbox branch a session from before the count could have made.
				const floor = Math.max(-1, ...Object.values(sessions).map((s) => s.sandboxNumber ?? s.sandbox ?? -1)) + 1;
				const number = Math.max(numbers.next, floor, inCheckout);
				numbers.next = number + 1;
				record = {
					id,
					workspace: project?.workspace ?? config.workspaces[0]?.name ?? "local",
					project: project?.name ?? NO_PROJECT,
					dir,
					title: prompt.split("\n")[0]!.slice(0, 80),
					createdAt: Date.now(),
					baseError: "A sandbox session's files are on the sandbox.",
					sandboxNumber: number,
					sandboxState: "preparing",
					...(options.approvals === undefined ? {} : { approvals: options.approvals }),
					...(options.group === undefined ? {} : { group: options.group }),
					...(options.size === undefined ? {} : { sandboxSize: options.size }),
					source: project?.dir ?? resolve(scratchRoot, String(id)),
					...(project === undefined ? { scratch: true } : {}),
				};
				sessions[String(id)] = record;
			},
		}, context);
		if (project === undefined) await scratchRepository(record!.source!);
		untitled.add(record!.id);
		for (const listener of created) listener(record!);
		void prepareSandbox(record!.id, options.onProgress);
		return record!;
	}

	/**
	 * Makes session `id`'s sandbox, recording each step, then sends the messages held for it, in order. A failure is
	 * recorded as the reason, and the held messages stay unsent. Also run at start for sessions a restart caught preparing.
	 * Resolves with the record once it's ready or failed; never rejects.
	 */
	function prepareSandbox(id: number, onProgress?: (line: string) => void): Promise<SessionRecord> {
		const going = preparing.get(id);
		if (going !== undefined) return going;
		const run = (async () => {
			const record = await get(id);
			if (record === undefined) throw new Error(`no session ${id}`);
			if (record.sandbox !== undefined || record.sandboxState !== "preparing") return record;
			const project = record.source === undefined ? undefined
				: record.scratch === true ? { name: SCRATCH_NAME, dir: record.source }
				: projects().find((p) => p.dir === record.source) ?? { name: record.project, dir: record.source };
			try {
				// Its own size, else the project's at the commit its template is made from.
				const size = record.sandboxSize ?? (project === undefined ? undefined : parseProjectConfig(await runCommand("git", ["-C", project.dir, "show", "HEAD:.agents/project.json"]).catch(() => undefined)).size) ?? "small";
				if (record.sandboxSize !== size) await changeRecord(id, (r) => void (r.sandboxSize = size));
				const made = await sandboxes.create(project === undefined ? undefined : { name: project.name, dir: project.dir }, onProgress, (step) => void changeRecord(id, (r) => {
					if (r.sandboxState === "preparing") r.sandboxStep = step;
				}).catch(() => undefined), size);
				// The directory was named when the session was made; a sandbox host that put it elsewhere moves the agent too.
				if (made.dir !== record.dir) await (await conversation(id)).configure({ cwd: made.dir }, context);
				const ready = await changeRecord(id, (r) => {
					r.sandbox = made.sandbox;
					r.dir = made.dir;
					r.sandboxState = "ready";
					delete r.sandboxStep;
					if (made.base !== undefined) r.sandboxBase = made.base;
				});
				await sendHeld(id);
				return ready ?? record;
			} catch (error) {
				const reason = error instanceof Error ? error.message.slice(-2000) : String(error);
				// Unless the host closed meanwhile: then a restart makes the sandbox again.
				if (closing) return record;
				console.error(`[sandbox] session ${id}: couldn't make its sandbox: ${reason}`);
				return (await changeRecord(id, (r) => {
					r.sandboxState = "failed";
					r.sandboxReason = reason;
					delete r.sandboxStep;
				})) ?? record;
			}
		})().finally(() => preparing.delete(id));
		preparing.set(id, run);
		return run;
	}

	/**
	 * A sandbox session started the old way: waits while the sandbox is made, printing its progress, and throws if it
	 * couldn't be. For the CLI, the HTTP API and MCP.
	 */
	async function createSandbox(project: Project | undefined, prompt: string, agent: { model?: string; thinking?: Thinking } = {}, onProgress?: (line: string) => void): Promise<SessionRecord> {
		const started = await startSandbox(project, prompt, agent, onProgress === undefined ? {} : { onProgress });
		const done = await prepareSandbox(started.id);
		if (done.sandboxState === "failed") throw new Error(`couldn't make session ${done.id}'s sandbox: ${done.sandboxReason}`);
		return done;
	}

	/**
	 * Keeps a message for sandbox session `id` until its sandbox is ready, in the database, so a restart doesn't lose it.
	 * A request ID already held isn't held twice. Returns false when the sandbox is ready already (send it instead). Once
	 * the sandbox has failed, messages are refused, except a session's first (`first`), which stays unanswered with it.
	 */
	async function hold(id: number, content: UserMessage["content"], requestId: string = randomUUID(), first = false): Promise<boolean> {
		const held = await root.commit(async (tx) => {
			const record = (await tx.doc(Sessions)).sessions[String(id)];
			if (record === undefined) throw new Error(`no session ${id}`);
			if (record.sandboxState === "failed" && !first) throw new SandboxNotReady(`session ${id}'s sandbox couldn't be made: ${record.sandboxReason}`);
			if (record.sandbox !== undefined) return false;
			const doc = await tx.doc(Held, String(id), null);
			if (!doc.messages.some((m) => m.requestId === requestId)) doc.messages = [...doc.messages, { content: JSON.stringify(content), requestId }];
			return true;
		}, context);
		// Checked in the same commit that holds it, so a message is either held before the sandbox is ready, and sent with
		// the rest, or refused here and sent by the caller.
		if (!held) return false;
		if (untitled.delete(id)) void writeTitle(id, withoutFileNotes(withoutVideoNotes(textOf(content))));
		return true;
	}

	/** Messages held for session `id`, oldest first. */
	async function heldMessages(id: number): Promise<{ content: UserMessage["content"]; requestId: string }[]> {
		const doc = await harness.snapshot(Held, String(id), context);
		// SAFETY: held content is a UserMessage's content, stored as its JSON.
		return (doc?.messages ?? []).map((m) => ({ content: JSON.parse(m.content) as UserMessage["content"], requestId: m.requestId }));
	}

	/** Sends session `id` its held messages, then forgets them. Each keeps its request ID, so a resend after a crash is a no-op. */
	async function sendHeld(id: number): Promise<void> {
		const messages = await heldMessages(id);
		for (const message of messages) await submit(id, message.content, { requestId: message.requestId });
		if (messages.length === 0) return;
		await root.commit(async (tx) => {
			const doc = await tx.doc(Held, String(id), null);
			doc.messages = doc.messages.filter((m) => !messages.some((sent) => sent.requestId === m.requestId));
		}, context);
	}

	/** Picks up sandboxes a restart caught being made, held messages it caught being sent, and ships it cut off. */
	async function resumeSandboxes(): Promise<void> {
		const records = await list();
		for (const record of records) {
			if (record.sandboxState === "preparing" && record.sandbox === undefined) void prepareSandbox(record.id);
			else if (record.sandbox !== undefined) await sendHeld(record.id);
		}
		ships.resume(records);
	}

	/** Sandbox session `id`'s record, for work with its sandbox and its local project; throws when it has neither. */
	async function sandboxRecord(id: number): Promise<SessionRecord & { sandbox: number; source: string }> {
		const record = await get(id);
		if (record === undefined) throw new Error(`no session ${id}`);
		if (!isSandboxSession(record)) throw new Error(`session ${id} isn't in a sandbox`);
		if (record.sandbox === undefined) throw new Error(`session ${id}'s sandbox isn't ready${record.sandboxState === "failed" ? `: ${record.sandboxReason}` : " yet"}`);
		if (record.sandboxRemoved === true) throw new Error(`session ${id}'s sandbox was deleted when it was archived; its commits were fetched then`);
		if (record.source === undefined) throw new Error(`session ${id} has no project to sync into`);
		return record as SessionRecord & { sandbox: number; source: string };
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

	/**
	 * Archives session `id`, or brings it back with false; returns its record. Archiving only hides it from the lists.
	 * Bringing one back by hand keeps it from the idle archive; archiving it again lets it go back to the usual rule.
	 */
	async function archive(id: number, archived: boolean): Promise<SessionRecord> {
		const record = await root.commit(async (tx) => {
			const found = (await tx.doc(Sessions)).sessions[String(id)];
			if (found === undefined) throw new Error(`no session ${id}`);
			if (archived) {
				found.archived = true;
				delete found.kept;
			} else {
				if (found.archived === true) found.kept = true;
				delete found.archived;
			}
			return { ...found };
		}, context);
		updated.forEach((listener) => listener(record));
		return record;
	}

	/** Archives session `id` for being idle, unless it was kept or archived meanwhile; returns whether it did. */
	async function archiveIdle(id: number): Promise<boolean> {
		const record = await root.commit(async (tx) => {
			const found = (await tx.doc(Sessions)).sessions[String(id)];
			if (found === undefined || found.archived === true || found.kept === true) return undefined;
			found.archived = true;
			return { ...found };
		}, context);
		if (record !== undefined) updated.forEach((listener) => listener(record));
		return record !== undefined;
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
		const record = await get(id);
		if (isSandboxSession(record) && record!.sandbox === undefined) {
			throw new SandboxNotReady(record!.sandboxState === "failed" ? `session ${id}'s sandbox couldn't be made: ${record!.sandboxReason}` : `session ${id}'s sandbox is still being made; its messages wait for it`);
		}
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

	const sandboxApi = {
		/** Puts `ref` of sandbox session `id`'s local project into its sandbox as refs/aludra/base (src/ship.ts). */
		async receiveBase(id: number, ref: string): Promise<string> {
			const record = await sandboxRecord(id);
			return sandboxes.receiveBase(record.sandbox, record.dir, record.source, ref);
		},
		/**
		 * Fetches sandbox session `id`'s commits into its project's local checkout, as `into` (default its branch);
		 * with `merge`, then fast-forwards the checked-out branch to them when that's safe (src/sandboxes.ts).
		 */
		async sync(id: number, into?: string, options: { merge?: boolean; force?: boolean } = {}): Promise<SyncResult & { merge?: MergeResult }> {
			const record = await sandboxRecord(id);
			const synced = await sandboxes.sync(record.sandbox, record.dir, record.source, into ?? sandboxBranch(record), { force: options.force === true });
			// The branch is back, so archiving fetches it again before deleting the sandbox.
			if (record.sandboxDiscarded === true && into === undefined) await changeRecord(id, (r) => void delete r.sandboxDiscarded);
			if (options.merge !== true) return synced;
			return { ...synced, merge: await fastForward(record.source, synced.branch) };
		},
	};

	/** Ships started from clients (src/ship.ts): one at a time per session, picked up again after a restart. */
	const ships = createShips({
		sessions: { get },
		sandboxes: sandboxApi,
		states,
		// After the checks and screenshots of the run before, so a ship never runs beside them.
		ask: async (id, prompt, requestId) => {
			await results.idle(id);
			return askSession({ submit, harness }, id, prompt, requestId);
		},
		mark: async (id, change) => {
			await changeRecord(id, (r) => {
				if ("shipping" in change) {
					r.shipping = change.shipping;
					delete r.shipStopped;
					return;
				}
				delete r.shipping;
				const outcome = shipOutcome(change.done, change.at);
				if ("shipped" in outcome) {
					r.shipped = outcome.shipped;
					delete r.shipStopped;
				} else r.shipStopped = outcome.shipStopped;
			});
		},
	});

	/** Sandbox sessions' results (src/results.ts): read from the transcript, with checks run after each run. */
	const resultListeners = new Set<(id: number) => void>();
	const results = createResults({
		entries: (id) => async (cursor) => {
			const found = await conversation(id);
			// SAFETY: the cursor is one this function returned.
			return found.entries({}, 50, cursor as Parameters<typeof found.entries>[2], context);
		},
		running: async (id) => (await states()).get(id) !== "idle",
		sandbox: async (id) => {
			const record = await get(id);
			if (record?.sandbox === undefined || record.source === undefined || record.sandboxRemoved === true) return undefined;
			return {
				env: sandboxes.env(record.sandbox, record.dir),
				dir: record.dir,
				source: record.source,
				branch: sandboxBranch(record),
				...(record.sandboxBase === undefined ? {} : { base: record.sandboxBase }),
				shipping: record.shipping !== undefined,
			};
		},
		readChecks: (id) => harness.snapshot(TurnChecks, String(id), context),
		writeChecks: (id, state) => root.commit(async (tx) => void Object.assign(await tx.doc(TurnChecks, String(id), null), state), context),
		shotsDir,
		shipOutcome: async (id) => {
			const record = await get(id);
			if (record === undefined) return undefined;
			// The newer of the two, as a stopped ship is cleared once the next lands, but a landed one is kept.
			if (record.shipStopped !== undefined && (record.shipped === undefined || record.shipStopped.at > record.shipped.at)) return { shipStopped: record.shipStopped };
			return record.shipped === undefined ? undefined : { shipped: record.shipped };
		},
		changed: (id) => resultListeners.forEach((listener) => listener(id)),
		context,
	});

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
		config.archive = next.archive;
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
		/** Days idle before a session is archived; 0 for never. */
		archiveAfterDays: () => config.archive.afterDays,
		/** Whether the MCP endpoint may start, message and stop sessions (the settings file's mcp.write). */
		mcpWrite: () => config.mcp.write,
		/** Where a ship lands by default (src/ship.ts). */
		shipMode: (): "main" | "branch" => config.sandboxes?.shipTo ?? "main",
		/** Ships started from clients (src/ship.ts). */
		ships,
		/** The sandbox settings clients see, or undefined without a sandbox host. */
		sandboxSettings: () => (config.sandboxes === undefined ? undefined : { shipTo: config.sandboxes.shipTo, afterRun: config.sandboxes.afterRun, approvals: config.sandboxes.approvals }),
		/** Whether sandbox session `record`'s tools wait for approvals. */
		sandboxApprovals,
		choices,
		/** Whether `provider` has model `id`. */
		hasModel: (provider: string, id: string) => models.getProvider(provider) !== undefined && models.getModel(provider, id) !== undefined,
		/** Every model a session can run on, by provider (src/catalog.ts). */
		catalog: () => catalog.list(),
		modelInfo,
		projects,
		/** Sandbox connections (spike): `close()` drops them, as being idle would, so the sandbox's host may pause it. */
		sandboxes: {
			close: (n?: number) => sandboxes.close(n),
			connected: (n: number) => sandboxes.connected(n),
			status: sandboxes.status,
			states: () => sandboxes.states(),
			remove: sandboxes.remove,
			receiveBase: sandboxApi.receiveBase,
			sync: sandboxApi.sync,
			/** Deletes sandbox session `id`'s sandbox on its host and marks the session; nothing is fetched first. */
			async forget(id: number): Promise<void> {
				const record = await get(id);
				if (record?.sandbox === undefined || record.sandboxRemoved === true) return;
				await sandboxes.remove(record.sandbox);
				const marked = await root.commit(async (tx) => {
					const found = (await tx.doc(Sessions)).sessions[String(id)];
					if (found === undefined) return undefined;
					found.sandboxRemoved = true;
					return { ...found };
				}, context);
				if (marked !== undefined) updated.forEach((listener) => listener(marked));
			},
			/**
			 * Deletes sandbox session `id`'s branch in its project's checkout, unmerged commits and all; returns the commit
			 * it was at, or undefined when there was none. The sandbox stays.
			 */
			async discard(id: number): Promise<{ branch: string; head?: string }> {
				const record = await get(id);
				if (!isSandboxSession(record)) throw new Error(`session ${id} isn't in a sandbox`);
				if (record!.source === undefined) throw new Error(`session ${id} has no project`);
				const branch = sandboxBranch(record!);
				const head = await deleteBranch(record!.source, branch);
				await changeRecord(id, (r) => void (r.sandboxDiscarded = true));
				return { branch, ...(head === undefined ? {} : { head }) };
			},
			hold,
			held: heldMessages,
			/** Resolves once session `id`'s sandbox is ready or failed. */
			prepared: (id: number) => prepareSandbox(id),
		},
		sessions: { list, get, create, createScratch, createSandbox, startSandbox, onCreate, rename, retitle, regenerateTitle, archive, archiveIdle, onUpdate, states },
		/** Sandbox sessions' results (src/results.ts). */
		results: {
			result: results.result,
			line: results.line,
			/** Whether session `id`'s latest turn is a ship's. */
			shipTurn: results.shipTurn,
			/** Runs the project's declared checks once session `id`'s run has ended with an answer; never throws. */
			afterRun: results.afterRun,
			settled: results.settled,
			/** Session `id`'s screenshot `shot` as PNG bytes, or undefined when there's none (src/shots.ts). */
			shot: (id: number, shot: string) => readShot(shotsDir, id, shot),
			/** Calls `listener` with a session whose checks started or finished. */
			onChange(listener: (id: number) => void): () => void {
				resultListeners.add(listener);
				return () => resultListeners.delete(listener);
			},
		},
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
		/** New projects (src/new-projects.ts): where they go when this host can make them, and making one. */
		newProjects: { info: newProjectsInfo, create: createProject, promote },
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
		resume: () => {
			harness.resume();
			void resumeSandboxes().catch((error) => console.error(`[sandbox] resuming: ${error instanceof Error ? error.message : String(error)}`));
		},
		search: searchMessages,
		/** Page `page` of session `id` (src/pages.ts), or undefined. */
		page: pages.read,
		/** Empties the search index and builds it again from every session. */
		reindex: async () => {
			await caughtUp;
			searchIndex.reset();
			return catchUp();
		},
		close: async () => {
			closing = true;
			clearInterval(sweeper);
			stopIndexing();
			await caughtUp;
			await harness.close(context);
			searchIndex.close();
			sandboxes.close();
		},
	};
}

export type Host = Awaited<ReturnType<typeof openHost>>;
