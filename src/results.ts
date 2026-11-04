// A sandbox session's result: what its latest turn did, in plain words, for someone who judges the work without reading
// the code (amyrlin's protocol section 10 item 19, "Results"). The agent is asked, in its prompt's sandbox section
// (src/context.ts), to end each reply with a fenced `result` block of JSON and to keep a `plan` checklist block while it
// works; the host reads them from the transcript when asked, so nothing is stored for them. What the agent can't be
// trusted to say comes from elsewhere: checks from the project's declared commands, run in the sandbox once the run
// ends (`.agents/project.json`, `checks`), or from the turn's own test and build calls when none are declared; and the
// code's size from `sandbox/N` against the commit the sandbox was made from, in the local checkout.
import { relative } from "node:path";
import { realpath } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { defineDocFamily, type EntryRecord } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Changes } from "./api-types.ts";
import { changesBetween, fileDiffBetween, type Snapshot } from "./changes.ts";
import { run } from "./sandboxes.ts";
import { textOf } from "./transcript.ts";

export type HeadsUp = { kind: "upstream" | "dependency" | "left" | "other"; text: string };
export type Check = { name: string; ok: boolean; detail?: string };
export type PlanStep = { text: string; done: boolean };
export type Question = { text: string; why?: string; options: string[] };
export type Code = { commits: number; files: number; add: number; del: number };

/** What the agent said in its answer: its result block, or the answer's first paragraph without one. */
export type Said = { summary: string; changes: string[]; headsUp: HeadsUp[]; question?: Question };

export type TaskResult = Said & { at: number; checks: Check[]; shots: never[]; code: Code; plan?: PlanStep[] };

const HEADS_UP_KINDS = new Set(["upstream", "dependency", "left", "other"]);
/** Longest summary, change or heads-up kept; a model that writes more is cut, not refused. */
const MAX_TEXT = 600;
const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/** Fenced blocks with `lang` in `text`, in order: their bodies. */
function blocks(text: string, lang: string): string[] {
	const found: string[] = [];
	const pattern = new RegExp("^(`{3,}|~{3,})[ \\t]*" + lang + "[ \\t]*\\n([\\s\\S]*?)^\\1[ \\t]*$", "gm");
	for (const match of text.matchAll(pattern)) found.push(match[2]!);
	return found;
}

/** `text` without its `result` and `plan` blocks and ship verdict lines: what a reader of the transcript sees as prose. */
export function prose(text: string): string {
	return text
		.replace(/^(`{3,}|~{3,})[ \t]*(result|plan)[ \t]*\n[\s\S]*?^\1[ \t]*$/gm, "")
		.split("\n")
		.filter((line) => !/^`?SHIP-(READY|BLOCKED)\b/.test(line.trim()))
		.join("\n")
		.trim();
}

/** The first paragraph of `text`'s prose, as one line, without Markdown's marks. */
export function firstParagraph(text: string): string {
	const paragraph = prose(text).split(/\n\s*\n/).find((p) => p.trim() !== "") ?? "";
	return cut(paragraph.replace(/\s*\n\s*/g, " ").replace(/[*_`#>]/g, "").trim());
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => cut(v.trim())) : []);

/** What answer `text` says: its last `result` block, read leniently, or its first paragraph as the summary. */
export function parseSaid(text: string): Said {
	const fallback: Said = { summary: firstParagraph(text), changes: [], headsUp: [] };
	const body = blocks(text, "result").at(-1);
	if (body === undefined) return fallback;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return fallback;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
	const v = value as Record<string, unknown>;
	const summary = typeof v.summary === "string" && v.summary.trim() !== "" ? cut(v.summary.trim()) : fallback.summary;
	const headsUp = Array.isArray(v.headsUp)
		? v.headsUp.flatMap((h): HeadsUp[] => {
			if (typeof h === "string" && h.trim() !== "") return [{ kind: "other", text: cut(h.trim()) }];
			if (typeof h !== "object" || h === null) return [];
			const { kind, text: said } = h as Record<string, unknown>;
			if (typeof said !== "string" || said.trim() === "") return [];
			return [{ kind: typeof kind === "string" && HEADS_UP_KINDS.has(kind) ? (kind as HeadsUp["kind"]) : "other", text: cut(said.trim()) }];
		})
		: [];
	let question: Question | undefined;
	if (typeof v.question === "string" && v.question.trim() !== "") question = { text: cut(v.question.trim()), options: [] };
	else if (typeof v.question === "object" && v.question !== null) {
		const q = v.question as Record<string, unknown>;
		if (typeof q.text === "string" && q.text.trim() !== "") {
			question = { text: cut(q.text.trim()), options: strings(q.options).slice(0, 6), ...(typeof q.why === "string" && q.why.trim() !== "" ? { why: cut(q.why.trim()) } : {}) };
		}
	}
	return { summary, changes: strings(v.changes), headsUp, ...(question === undefined ? {} : { question }) };
}

/** The last `plan` checklist in `text`, or undefined without one. */
export function parsePlan(text: string): PlanStep[] | undefined {
	const body = blocks(text, "plan").at(-1);
	if (body === undefined) return undefined;
	const steps = body.split("\n").flatMap((line): PlanStep[] => {
		const m = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
		return m === null ? [] : [{ text: cut(m[2]!), done: m[1] !== " " }];
	});
	return steps.length === 0 ? undefined : steps;
}

/** Pages of a conversation's entries, newest first. */
export type EntryPages = (cursor: unknown) => Promise<{ items: readonly EntryRecord[]; next?: unknown }>;

/** The latest turn: the user message that started it, and every message after it, in order. */
export type Turn = { started: number; messages: Message[] };

/**
 * The latest turn of a conversation from its newest entries, read a page at a time (descending) until the user message
 * that started it. `page` is the conversation's `entries`.
 */
export async function latestTurn(page: EntryPages, maxEntries = 2000): Promise<Turn | undefined> {
	const newestFirst: EntryRecord[] = [];
	let cursor: unknown;
	do {
		const got = await page(cursor);
		for (const entry of got.items) {
			newestFirst.push(entry);
			if (entry.kind === "pi.user") {
				const messages = newestFirst.reverse().flatMap((e) => (e.kind === "pi.user" || e.kind === "pi.assistant" || e.kind === "pi.tool-result" ? [...(e.model ?? [])] : []));
				return { started: messages[0]?.timestamp ?? 0, messages };
			}
		}
		cursor = got.next;
	} while (cursor !== undefined && newestFirst.length < maxEntries);
	return undefined;
}

/** The plan of the latest turn, read from the newest entries back until one has a plan or the turn's start. */
export async function latestPlan(page: EntryPages, maxEntries = 400): Promise<PlanStep[] | undefined> {
	let seen = 0;
	let cursor: unknown;
	do {
		const got = await page(cursor);
		for (const entry of got.items) {
			seen += 1;
			if (entry.kind === "pi.user") return undefined;
			for (const m of [...(entry.model ?? [])].reverse()) {
				if (m.role !== "assistant") continue;
				const plan = parsePlan(textOf(m.content));
				if (plan !== undefined) return plan;
			}
		}
		cursor = got.next;
	} while (cursor !== undefined && seen < maxEntries);
	return undefined;
}

/** The turn's final answer: its last assistant message, when that ended the turn with text and no error. */
export function finalAnswer(turn: Turn): AssistantMessage | undefined {
	const last = turn.messages.at(-1);
	if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted" || last.stopReason === "toolUse") return undefined;
	return last;
}

/** The latest plan the agent wrote in the turn. */
export function planOf(turn: Turn): PlanStep[] | undefined {
	for (let i = turn.messages.length - 1; i >= 0; i--) {
		const m = turn.messages[i]!;
		if (m.role !== "assistant") continue;
		const plan = parsePlan(textOf(m.content));
		if (plan !== undefined) return plan;
	}
	return undefined;
}

/** A command that tests, builds, type-checks or lints: one segment of a bash call, by the program it runs. */
const CHECK_SEGMENT = [
	/^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:test|build|lint|check|typecheck|type-check|tsc)\b/,
	/^(?:(?:pnpm|npm|yarn|bun)\s+exec\s+|npx\s+|bunx\s+)?(?:tsc|vitest|jest|mocha|playwright\s+test|eslint|oxlint|biome\s+check)\b/,
	/^(?:python3?\s+-m\s+)?pytest\b/,
	/^(?:cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|swift\s+(?:test|build)|xcodebuild|make)\b/,
	/^node\s+(?:--\S+\s+)*--test\b/,
];

/** The segments of `command` that run checks, trimmed: split at `&&`, `||`, `;`, pipes and lines. */
export function checkSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\||\n/)
		.map((part) => part.trim().replace(/^(?:\w+=\S*\s+)+/, ""))
		.filter((part) => CHECK_SEGMENT.some((pattern) => pattern.test(part)))
		.map((part) => part.replace(/\s*\d?>\s*&?\S+/g, "").trim());
}

/** Checks read from the turn's own bash calls that test or build: the last run of each command, passing or not. */
export function callChecks(turn: Turn): Check[] {
	const results = new Map<string, { isError: boolean; text: string }>();
	for (const m of turn.messages) if (m.role === "toolResult") results.set(m.toolCallId, { isError: m.isError, text: textOf(m.content) });
	const byName = new Map<string, Check>();
	for (const m of turn.messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== "bash") continue;
			const command = typeof block.arguments.command === "string" ? block.arguments.command : "";
			const segments = checkSegments(command);
			const result = results.get(block.id);
			if (segments.length === 0 || result === undefined) continue;
			const joined = segments.join(" && ");
			const name = joined.length > 80 ? `${joined.slice(0, 79)}…` : joined;
			byName.delete(name);
			byName.set(name, { name, ok: !result.isError, ...(result.isError ? { detail: tail(result.text) } : {}) });
		}
	}
	return [...byName.values()];
}

/** The end of a command's output, for a check's detail. */
const tail = (text: string, max = 2000) => {
	const trimmed = text.trim();
	return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
};

/** The project's own settings for aludra, `.agents/project.json`: what to run as checks once a turn ends. */
export type ProjectConfig = { checks: { name: string; command: string }[] };

/** `.agents/project.json` read leniently: `checks` as commands, or `{ name, command }`. Missing or unreadable is none. */
export function parseProjectConfig(text: string | undefined): ProjectConfig {
	if (text === undefined) return { checks: [] };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { checks: [] };
	}
	const list = typeof value === "object" && value !== null ? (value as Record<string, unknown>).checks : undefined;
	if (!Array.isArray(list)) return { checks: [] };
	const checks = list.flatMap((c): ProjectConfig["checks"] => {
		if (typeof c === "string" && c.trim() !== "") return [{ name: c.trim(), command: c.trim() }];
		if (typeof c !== "object" || c === null) return [];
		const { name, command } = c as Record<string, unknown>;
		if (typeof command !== "string" || command.trim() === "") return [];
		return [{ name: typeof name === "string" && name.trim() !== "" ? name.trim() : command.trim(), command: command.trim() }];
	});
	return { checks: checks.slice(0, 10) };
}

/** How long one declared check may run, in seconds. */
export const CHECK_TIMEOUT_S = 15 * 60;

/** Reads the project's `.agents/project.json` in `dir` through `env`, the sandbox's. */
export async function readProjectConfig(env: ExecutionEnv, dir: string, context: Context): Promise<ProjectConfig> {
	const read = await env.readTextFile(`${dir}/.agents/project.json`, context);
	return parseProjectConfig(read.ok ? read.value : undefined);
}

/** Runs each check in `dir` through `env`, one after another; a check that can't start fails with why. */
export async function runChecks(env: ExecutionEnv, dir: string, checks: ProjectConfig["checks"], context: Context, timeout = CHECK_TIMEOUT_S): Promise<Check[]> {
	const results: Check[] = [];
	for (const check of checks) {
		let output = "";
		const ran = await env.exec(["bash", "-lc", check.command], { cwd: dir, timeout, onOutput: (text) => {
			output = (output + text).slice(-8000);
		} }, context);
		if (!ran.ok) results.push({ name: check.name, ok: false, detail: tail(`${output}\n${ran.error.message}`) });
		else results.push({ name: check.name, ok: ran.value.exitCode === 0, ...(ran.value.exitCode === 0 ? {} : { detail: tail(output) || `exited with code ${ran.value.exitCode}` }) });
	}
	return results;
}

/**
 * The turn of the latest final answer: from the user message that started it to that answer. Turns after it that
 * ended without one (stopped, failed) are passed over, so the result stays the last one the agent gave.
 */
export async function answeredTurn(page: EntryPages, maxEntries = 2000): Promise<Turn | undefined> {
	const newestFirst: EntryRecord[] = [];
	let answered = false;
	let seen = 0;
	let cursor: unknown;
	do {
		const got = await page(cursor);
		for (const entry of got.items) {
			seen += 1;
			if (!answered) {
				const last = entry.kind === "pi.assistant" ? entry.model?.at(-1) : undefined;
				if (last?.role !== "assistant" || finalAnswer({ started: 0, messages: [last] }) === undefined) continue;
				answered = true;
			}
			newestFirst.push(entry);
			if (entry.kind === "pi.user") {
				const messages = newestFirst.reverse().flatMap((e) => (e.kind === "pi.user" || e.kind === "pi.assistant" || e.kind === "pi.tool-result" ? [...(e.model ?? [])] : []));
				return { started: messages[0]?.timestamp ?? 0, messages };
			}
		}
		cursor = got.next;
	} while (cursor !== undefined && seen < maxEntries);
	return undefined;
}

/** Checks run once a run ended, by session: for the answer at `at`, `running` until they're done. */
export type TurnCheckState = { at: number; running: boolean; checks: Check[] };
export const TurnChecks = defineDocFamily<TurnCheckState, null>({
	kind: "aludra.turn-checks",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ at: 0, running: false, checks: [] }),
});

/** The repository `source` is in, as a snapshot whose tree is unused, for changes between two commits. */
async function repositoryOf(source: string): Promise<Snapshot> {
	const top = (await run("git", ["-C", source, "rev-parse", "--show-toplevel"])).trim();
	return { tree: "", top, prefix: relative(top, await realpath(source)), at: 0 };
}

/** The commit `branch` is at in `source`, or undefined when there's no such branch. */
export async function branchHead(source: string, branch: string): Promise<string | undefined> {
	const head = (await run("git", ["-C", source, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).catch(() => "")).trim();
	return head === "" ? undefined : head;
}

/** What `branch` changes over `base` in the local checkout `source`, as checkpoints.changes has it. */
export async function codeChanges(source: string, base: string, branch: string): Promise<Changes> {
	const head = await branchHead(source, branch);
	if (head === undefined) return { available: false, reason: `${branch} isn't in the project yet; it comes home when the run ends, or with sandbox.sync` };
	return changesBetween(await repositoryOf(source), base, head, 0);
}

/** One file's diff in `branch` over `base`; only a file in its changes has one. */
export async function codeDiff(source: string, base: string, branch: string, path: string): Promise<string> {
	const changes = await codeChanges(source, base, branch);
	if (!changes.available || !changes.files.some((f) => f.path === path)) throw new Error(`no file ${path} changed on ${branch}`);
	return fileDiffBetween(await repositoryOf(source), base, (await branchHead(source, branch))!, path);
}

/** The size of `branch`'s work over `base`: commits, files, lines added and deleted. Zeros when it isn't here. */
export async function codeCounts(source: string, base: string, branch: string): Promise<Code> {
	const head = await branchHead(source, branch);
	if (head === undefined) return { commits: 0, files: 0, add: 0, del: 0 };
	const [changes, commits] = await Promise.all([
		codeChanges(source, base, branch),
		run("git", ["-C", source, "rev-list", "--count", `${base}..${head}`]).then((s) => Number(s.trim()) || 0, () => 0),
	]);
	if (!changes.available) return { commits, files: 0, add: 0, del: 0 };
	return { commits, files: changes.files.length, add: changes.add, del: changes.del };
}

/** What results need of the host. */
export type ResultsHost = {
	/** Pages of session `id`'s entries, newest first. */
	entries(id: number): EntryPages;
	/** Whether session `id` runs now (or waits on an approval). */
	running(id: number): Promise<boolean>;
	/** Session `id`'s sandbox: its environment, its directory there, its branch here and the commit it started from. */
	sandbox(id: number): Promise<{ env: ExecutionEnv; dir: string; source: string; branch: string; base?: string; shipping: boolean } | undefined>;
	/** Session `id`'s recorded checks, and recording them (the TurnChecks document). */
	readChecks(id: number): Promise<TurnCheckState | undefined>;
	writeChecks(id: number, state: TurnCheckState): Promise<void>;
	/** Tells listeners session `id`'s result changed. */
	changed(id: number): void;
	context: Context;
	log?: (line: string) => void;
};

export function createResults(host: ResultsHost) {
	const log = host.log ?? ((line: string) => console.error(`[results] ${line}`));
	const going = new Map<number, Promise<void>>();

	/**
	 * The checks for the answer at `at`: the declared ones once run, else the turn's own test and build calls. Declared
	 * checks a restart cut off count as not run.
	 */
	async function checksFor(id: number, at: number, turn: Turn): Promise<{ running: boolean; checks: Check[] }> {
		const stored = await host.readChecks(id);
		if (stored === undefined || stored.at !== at || (stored.running && !going.has(id))) return { running: false, checks: callChecks(turn) };
		return stored.running ? { running: true, checks: callChecks(turn) } : { running: false, checks: stored.checks };
	}

	/**
	 * Session `id`'s latest result: while it runs, its plan; after, what the latest answer said with its checks and code.
	 * Undefined before any answer.
	 */
	async function result(id: number): Promise<TaskResult | { at: number; plan: PlanStep[] } | undefined> {
		if (await host.running(id)) {
			const turn = await latestTurn(host.entries(id));
			if (turn !== undefined) return { at: turn.started, plan: planOf(turn) ?? [] };
		}
		const turn = await answeredTurn(host.entries(id));
		const answer = turn === undefined ? undefined : finalAnswer(turn);
		if (turn === undefined || answer === undefined) return undefined;
		const said = parseSaid(textOf(answer.content));
		const sandbox = await host.sandbox(id);
		const { checks } = await checksFor(id, answer.timestamp, turn);
		const code = sandbox?.base === undefined ? { commits: 0, files: 0, add: 0, del: 0 } : await codeCounts(sandbox.source, sandbox.base, sandbox.branch).catch(() => ({ commits: 0, files: 0, add: 0, del: 0 }));
		const plan = planOf(turn);
		return { at: answer.timestamp, ...said, checks, shots: [], code, ...(plan === undefined ? {} : { plan }) };
	}

	/** Session `id`'s one line for the task list, or undefined when there's nothing to say yet. */
	async function line(id: number, running: boolean): Promise<string | undefined> {
		if (running) {
			const plan = await latestPlan(host.entries(id));
			return taskLine({ running: true, ...(plan === undefined ? {} : { plan }) });
		}
		const turn = await answeredTurn(host.entries(id), 400);
		const answer = turn === undefined ? undefined : finalAnswer(turn);
		if (answer === undefined) return undefined;
		const checks = await checksFor(id, answer.timestamp, turn!);
		return taskLine({ running: false, said: parseSaid(textOf(answer.content)), checks });
	}

	/**
	 * After session `id`'s run ends with an answer: runs the project's declared checks in its sandbox, once per answer, and
	 * records them. Nothing for a session outside a sandbox, one shipping (a check's build output would be left
	 * uncommitted), or a project that declares none. Never throws.
	 */
	function afterRun(id: number): Promise<void> {
		const running = going.get(id);
		if (running !== undefined) return running;
		const work = (async () => {
			const sandbox = await host.sandbox(id);
			if (sandbox === undefined || sandbox.shipping) return;
			const turn = await answeredTurn(host.entries(id));
			const answer = turn === undefined ? undefined : finalAnswer(turn);
			if (answer === undefined) return;
			const stored = await host.readChecks(id);
			if (stored?.at === answer.timestamp && !stored.running) return;
			const config = await readProjectConfig(sandbox.env, sandbox.dir, host.context);
			if (config.checks.length === 0) return;
			await host.writeChecks(id, { at: answer.timestamp, running: true, checks: [] });
			host.changed(id);
			const checks = await runChecks(sandbox.env, sandbox.dir, config.checks, host.context);
			await host.writeChecks(id, { at: answer.timestamp, running: false, checks });
			log(`session ${id}: ${checks.filter((c) => c.ok).length} of ${checks.length} checks pass`);
			host.changed(id);
		})().catch((error) => log(`session ${id}: checks: ${error instanceof Error ? error.message : String(error)}`)).finally(() => going.delete(id));
		going.set(id, work);
		return work;
	}

	return {
		result,
		line,
		afterRun,
		/** Resolves once the checks going now are done; for shutdown and tests. */
		settled: () => Promise.all(going.values()).then(() => undefined),
	};
}

/** The first sentence of `text`, for a task's one line. */
export function firstSentence(text: string, max = 120): string {
	const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
	return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/**
 * A task's one line, from what's known of it: the open question, the step of the plan it's on, checks running or
 * failing, or the result's summary.
 */
export function taskLine(input: { running: boolean; plan?: PlanStep[]; said?: Said; checks?: { running: boolean; checks: Check[] } }): string | undefined {
	if (input.running) {
		const step = input.plan?.find((s) => !s.done);
		return step === undefined ? "Working" : firstSentence(step.text);
	}
	if (input.said === undefined) return undefined;
	if (input.said.question !== undefined) return `Asks: ${firstSentence(input.said.question.text)}`;
	const summary = firstSentence(input.said.summary) || "Done";
	if (input.checks?.running === true) return `${summary} · running checks`;
	const failed = input.checks?.checks.filter((c) => !c.ok).length ?? 0;
	if (failed > 0) return `${summary} · ${failed} check${failed === 1 ? "" : "s"} fail${failed === 1 ? "s" : ""}`;
	if ((input.checks?.checks.length ?? 0) > 0) return `${summary} · checks pass`;
	return summary;
}
