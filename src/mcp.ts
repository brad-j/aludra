// The MCP endpoint: aludra's sessions as tools for agents it didn't start, such as Claude Code or pi in a terminal on
// another machine, so work can be handed between machines. Streamable HTTP at POST /mcp, served by the same server as
// the API (src/api.ts) and reached the same way, through tailscale serve.
//
// Who gets in: a bearer token made with `aludra token add` (src/tokens.ts), one per agent, and a request with an Origin
// is refused, since a browser always sends one and an agent's MCP client doesn't. Not the API's Tailscale login: a
// tagged machine has none, and it names a person rather than the agent. There's no OAuth. It's stateless, a server and
// transport per request, which suits a host that restarts and clients that reconnect.
//
// Reading: list_projects, read_plan (a project's docs/plan.md as its working copy has it, src/plans.ts), list_sessions,
// read_session, search_messages and read_subscription. Nothing here writes a plan, ships a session or makes a project;
// those are the apps' over /app.
//
// Writing is off unless the token's scope is write and the settings' mcp.write is true. Writing lets an agent start
// sessions, which run with every permission a session has (only git push and remote commands to approval hosts wait),
// so tokens are read-only and mcp.write is off by default; mcp.write turns writing off for every token at once. The
// write tools are start_session, send_message, stop_session, archive_session and unarchive_session. start_session
// always takes a project; scratch sessions are made from the apps over /app.
//
// mcp.sandboxOnly narrows writing to sandboxes: start_session makes only sandbox sessions, refusing a call that asks for
// a local one rather than quietly giving it a sandbox, and send_message and stop_session refuse any session that isn't
// in one, whoever started it. Without a sandbox host every write tool refuses, so nothing falls back to a local
// session. No tool here syncs or merges; what a run's end does to the checkout is sandboxes.afterRun's.
//
// mcp.worktreeOnly narrows writing to worktree sessions in the same way: start_session makes each session in a git
// worktree of its own on worktree/N, from the project's last commit, where git push is refused (src/permissions.ts), so
// nothing it does reaches the checked-out branch or a remote. A call with worktree: false is refused, and send_message
// and stop_session refuse any session that isn't in a worktree. Without worktreeOnly, worktree: true asks for one.
//
// archive_session and unarchive_session hide a session from the lists and bring it back, through host.sessions.archive
// as the apps do, so the archive's usual consequences follow: a sandbox session's sandbox is deleted once its commits
// are fetched to sandbox/N (src/sandbox-cleanup.ts). They act only on sandbox sessions whatever mcp.sandboxOnly says,
// and archive_session refuses a session that's running, waiting or still having its sandbox made, and one whose branch
// was discarded, since its sandbox would go without its commits being fetched.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Item } from "./api-types.ts";
import type { Host } from "./host.ts";
import type { Thinking } from "./config.ts";
import type { Scope, Token } from "./tokens.ts";
import { readSummary } from "./live.ts";
import { findProject } from "./projects.ts";
import { context, isSandboxSession, isWorktreeSession, worktreeBranch } from "./host.ts";
import { itemsOf } from "./transcript.ts";
import { shipLine } from "./ship.ts";
import type { SessionRecord } from "./host.ts";
import { originProblem, PLAN_ITEM_ID, planItems, readPlan } from "./plans.ts";

const THINKING_LIST = "off, minimal, low, medium, high, xhigh";

/** Longest text a tool answers with; transcripts keep their latest items within it. */
const MAX_TEXT = 60_000;

type Answer = { content: { type: "text"; text: string }[]; isError?: boolean };
const answer = (value: unknown): Answer => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): Answer => ({ content: [{ type: "text", text: message }], isError: true });

/** A transcript as plain text: who said what, and each call on a line. */
export function transcriptText(items: readonly Item[], limit = MAX_TEXT): string {
	const lines = items.map((item) => {
		switch (item.kind) {
			case "user":
				return `## User\n${item.text}`;
			case "answer":
				return `## Agent\n${item.text}`;
			case "call": {
				const arg = typeof item.args.command === "string" ? item.args.command : typeof item.args.path === "string" ? item.args.path : JSON.stringify(item.args).slice(0, 200);
				return `- ${item.tool} ${arg} (${item.status})`;
			}
			case "failure":
				return `## Failed (${item.type})\n${item.message}`;
			case "compacted":
				return "(earlier messages summarized)";
		}
	});
	const kept: string[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (used + lines[i]!.length > limit) {
			kept.unshift(`(${i + 1} earlier items left out)`);
			break;
		}
		kept.unshift(lines[i]!);
		used += lines[i]!.length + 1;
	}
	return kept.join("\n\n");
}

/** Why a token of `scope` can't write on `host`, or undefined when it can. */
export function writeRefusal(host: Host, scope: Scope): string | undefined {
	if (scope !== "write") return "this token is read-only";
	if (!host.mcpWrite()) return "the host's mcp.write setting is off";
	return undefined;
}

/** Why, under mcp.sandboxOnly, no write tool can act at all: there's no sandbox host. Undefined when they can. */
export function sandboxOnlyRefusal(host: Host): string | undefined {
	if (!host.mcpSandboxOnly()) return undefined;
	if (host.sandboxSettings() === undefined) return "mcp.sandboxOnly is on but the settings name no sandbox host (sandboxes), so no session can be started or changed over MCP";
	return undefined;
}

/**
 * The model and effort session `view` runs its next turn on, as start_session and send_message take them: a pinned
 * model's ID, else provider/id, and its thinking level; the host's defaults where the session names none.
 */
export function agentOf(host: Host, view: { docs: Record<string, unknown> }): { ref: { provider: string; modelId: string }; model: string; effort: Thinking } {
	// SAFETY: a document in the view is the JSON of its kind's state.
	const agent = view.docs["pi.agent"] as { model?: { provider: string; modelId: string }; thinkingLevel?: Thinking } | undefined;
	const ref = agent?.model ?? host.model;
	const pinned = host.choices().some((c) => c.provider === ref.provider && c.id === ref.modelId);
	return { ref, model: pinned ? ref.modelId : `${ref.provider}/${ref.modelId}`, effort: agent?.thinkingLevel ?? host.thinking };
}

/** Session `id`'s model and effort, as agentOf gives them. */
async function sessionAgent(host: Host, id: number) {
	const state = await (await host.conversation(id)).viewState(context);
	try {
		return agentOf(host, state.value);
	} finally {
		state.dispose();
	}
}

/**
 * A session's ship as MCP reports it: shipping while one goes on, else how the latest went, landed or stopped, with its
 * line. Undefined for a session that never shipped.
 */
export function shipOf(record: SessionRecord | undefined): { shipping: true } | { shipped: true; line: string; at: string; pushed: string; head: string; commits: number; pr?: string } | { shipped: false; line: string; at: string; kind: string; reason: string } | undefined {
	if (record === undefined) return undefined;
	if (record.shipping !== undefined) return { shipping: true };
	// The newer of the two, as a landed ship clears the stopped one and a new start clears both.
	const landed = record.shipped;
	const stopped = record.shipStopped;
	if (stopped !== undefined && (landed === undefined || stopped.at > landed.at)) {
		return { shipped: false, line: shipLine({ shipStopped: stopped }), at: new Date(stopped.at).toISOString(), kind: stopped.kind, reason: stopped.reason };
	}
	if (landed === undefined) return undefined;
	const answer = { shipped: true as const, line: shipLine({ shipped: landed }), at: new Date(landed.at).toISOString(), pushed: landed.pushed, head: landed.head, commits: landed.commits };
	return landed.pr === undefined ? answer : { ...answer, pr: landed.pr };
}

/** `{ ship }` for a session that shipped or is shipping, else nothing, to spread into an answer. */
function shipField(record: SessionRecord | undefined): { ship?: NonNullable<ReturnType<typeof shipOf>> } {
	const ship = shipOf(record);
	return ship === undefined ? {} : { ship };
}

/** `{ planItem, origin }` as far as the session has them, to spread into an answer. */
function sourceFields(record: SessionRecord | undefined): { planItem?: string; origin?: string } {
	return { ...(record?.planItem === undefined ? {} : { planItem: record.planItem }), ...(record?.origin === undefined ? {} : { origin: record.origin }) };
}

/**
 * The model and thinking a turn asks for, checked against what the session can run: a model a session can be started
 * with (a pinned ID, or provider/id), and a thinking level that model takes. `current` is the model the session has
 * now, which the effort is checked against when no model is given. A string is the reason it's refused.
 */
export function turnSettings(host: Host, asked: { model?: string | undefined; effort?: string | undefined }, current: { provider: string; modelId: string }): { model?: string; thinking?: Thinking } | string {
	let ref = current;
	if (asked.model !== undefined) {
		try {
			ref = host.chooseModel(asked.model)!;
		} catch {
			const pinned = host.choices().map((c) => c.id);
			return `unknown model ${asked.model}: use one of ${pinned.join(", ")}, or provider/id for another model this host has`;
		}
	}
	if (asked.effort !== undefined) {
		const levels = host.thinkingLevels(ref);
		if (!(levels as string[]).includes(asked.effort)) return `effort ${asked.effort} isn't one ${ref.provider}/${ref.modelId} takes: use one of ${levels.join(", ")}`;
	}
	return { ...(asked.model === undefined ? {} : { model: asked.model }), ...(asked.effort === undefined ? {} : { thinking: asked.effort as Thinking }) };
}

/** An MCP server over `host`'s sessions, for one request by `token`. */
export function mcpServer(host: Host, options: { machine: string; token: Pick<Token, "id" | "scope" | "createdAt"> }): McpServer {
	const refusal = writeRefusal(host, options.token.scope);
	// Fixed for the server's life, so the instructions and descriptions an agent sees don't change between calls.
	const sandboxOnly = host.mcpSandboxOnly();
	const worktreeOnly = host.mcpWorktreeOnly();
	const writing = refusal !== undefined
		? `This endpoint is read-only for you: ${refusal}.`
		: worktreeOnly
			? "You can also start a session with a task, send one a message, and stop it, in worktrees only: every session you start works in a git worktree of its own on a worktree/N branch made from the project's last commit, where git push is refused, and you can message or stop only worktree sessions. Its commits stay on that branch until the user merges them. Describe the task fully."
		: sandboxOnly
			? "You can also start a session with a task, send one a message, and stop it, in sandboxes only: every session you start runs in a sandbox VM of its own, and you can message, stop, archive or unarchive only sandbox sessions. Describe the task fully."
			: "You can also start a session with a task, send one a message, and stop it; sessions run with full permissions in their project, so describe the task fully. You can archive and unarchive sandbox sessions.";
	const server = new McpServer({ name: `aludra on ${options.machine}`, version: "1.0.0" }, {
		instructions: `aludra runs coding-agent sessions on ${options.machine}, each in a project directory there. List projects and sessions, read a session's transcript, and search what was said. ${writing}`,
	});
	/** Why a write tool can't act on session `id`, or undefined when it can; under sandboxOnly, only sandbox sessions. */
	const sessionRefusal = async (id: number): Promise<string | undefined> => {
		const blocked = sandboxOnlyRefusal(host);
		if (blocked !== undefined) return blocked;
		const record = await host.sessions.get(id);
		if (record === undefined) return `No session ${id}`;
		if (sandboxOnly && !isSandboxSession(record)) return `session ${id} isn't in a sandbox, and this endpoint acts only on sandbox sessions (mcp.sandboxOnly)`;
		if (worktreeOnly && !isWorktreeSession(record)) return `session ${id} isn't in a worktree, and this endpoint acts only on worktree sessions (mcp.worktreeOnly)`;
		return undefined;
	};
	/** As sessionRefusal, but only sandbox and worktree sessions whatever the mode: archiving is never for sessions in the checkout. */
	const archiveRefusal = async (id: number, tool: string): Promise<string | undefined> => {
		const refused = await sessionRefusal(id);
		if (refused !== undefined) return refused === `No session ${id}` ? `No session ${id}; list_sessions lists them, with includeArchived for archived ones` : refused;
		const record = await host.sessions.get(id);
		if (!isSandboxSession(record) && !isWorktreeSession(record)) return `session ${id} isn't in a sandbox or a worktree, and ${tool} acts only on those`;
		return undefined;
	};
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool("list_projects", { description: `The projects sessions can work in on ${options.machine}: name, workspace and directory.`, annotations: readOnly }, async () =>
		answer(host.projects().map((p) => ({ name: p.name, workspace: p.workspace, dir: p.dir }))),
	);

	server.registerTool("read_plan", {
		description: `A project's plan on ${options.machine}: the text of its docs/plan.md as the working copy has it now, uncommitted edits included, its sha256, and when it was last changed. A project with no plan answers exists: false.`,
		inputSchema: { project: z.string().describe("A name from list_projects") },
		annotations: readOnly,
	}, async ({ project }) => {
		try {
			return answer(await readPlan(findProject(host.projects(), project)));
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	});

	server.registerTool("list_sessions", {
		description: "Sessions, newest first: id, project, title, state (running, waiting, done, failed, stopped, idle), the latest activity, and the model and effort its next turn runs on, as start_session and send_message take them.",
		inputSchema: { project: z.string().optional().describe("Only this project's sessions"), includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
		annotations: readOnly,
	}, async ({ project, includeArchived, limit }) => {
		const records = (await host.sessions.list()).filter((s) => (includeArchived === true || s.archived !== true) && (project === undefined || s.project === project));
		const summaries = (await Promise.all(records.map((r) => readSummary(host, r.id)))).filter((s) => s !== undefined);
		summaries.sort((a, b) => b.updatedAt - a.updatedAt);
		const shown = summaries.slice(0, limit ?? 30);
		const agents = await Promise.all(shown.map((s) => sessionAgent(host, s.id)));
		const shipRecords = await Promise.all(shown.map((s) => host.sessions.get(s.id)));
		return answer(shown.map((s, i) => ({ id: s.id, project: s.project, title: s.title, state: s.state, line: s.line, updated: new Date(s.updatedAt).toISOString(), model: agents[i]!.model, effort: agents[i]!.effort, ...(s.archived === true ? { archived: true } : {}), ...sourceFields(shipRecords[i]), ...shipField(shipRecords[i]) })));
	});

	server.registerTool("read_session", {
		description: "A session's state, the model and effort its next turn runs on, and its transcript as text: messages, answers and each tool call on a line, latest kept when it's long.",
		inputSchema: { id: z.number().int() },
		annotations: readOnly,
	}, async ({ id }) => {
		const summary = await readSummary(host, id);
		if (summary === undefined) return failure(`No session ${id}; list_sessions lists them`);
		const state = await (await host.conversation(id)).viewState(context);
		try {
			const { model, effort } = agentOf(host, state.value);
			const record = await host.sessions.get(id);
			const ship = shipOf(record);
			const shipped = ship === undefined ? "" : `Ship: ${"shipping" in ship ? "shipping" : ship.line}\n`;
			const source = `${record?.planItem === undefined ? "" : `Plan item: ${record.planItem}\n`}${record?.origin === undefined ? "" : `Origin: ${record.origin}\n`}`;
			const header = `Session ${id}: ${summary.title}\nProject: ${summary.project} (${summary.dir})\nState: ${summary.state}\nModel: ${model}\nEffort: ${effort}\n${source}${shipped}\n`;
			return answer(header + transcriptText(itemsOf(state.value)));
		} finally {
			state.dispose();
		}
	});

	server.registerTool("search_messages", {
		description: "Messages and answers containing every word, across sessions or in one, best first, with the text around each match.",
		inputSchema: { query: z.string(), session: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional() },
		annotations: readOnly,
	}, async ({ query, session, limit }) => {
		const results = await host.search(query, { limit: limit ?? 20, ...(session === undefined ? {} : { session }) });
		return answer(results.map((r) => ({ session: r.session, project: r.project, title: r.title, from: r.from, at: new Date(r.at).toISOString(), snippet: r.snippet })));
	});

	server.registerTool("read_subscription", {
		description: `The Claude subscription's usage on ${options.machine}, as the latest answer reported it: status (allowed, allowed_warning, rejected), and each window (five_hour, seven_day, and per-model weekly ones when the account has them) with used, the fraction used, and resetsAt; overage when usage credit was in play. Every session here, and any other Claude client on the same account, spends the same windows. known: false until a Claude answer has come back.`,
		annotations: readOnly,
	}, async () => {
		const known = host.subscription.get();
		if (known === undefined) return answer({ known: false });
		const iso = (at: number) => new Date(at).toISOString();
		return answer({
			known: true,
			heard: iso(known.at),
			status: known.status,
			windows: Object.fromEntries(Object.entries(known.windows).map(([name, w]) => [name, { used: w.used, resetsAt: iso(w.resetsAt), ...(w.status === undefined ? {} : { status: w.status }) }])),
			...(known.overage === undefined ? {} : { overage: { ...known.overage, ...(known.overage.resetsAt === undefined ? {} : { resetsAt: iso(known.overage.resetsAt) }) } }),
		});
	});

	if (refusal === undefined) {
		const turnFields = {
			model: z.string().min(1).optional().describe(`The model for this turn and the session's turns after it: one of ${host.choices().map((c) => c.id).join(", ")}, or provider/id. Default: the session's model, or the host's default for a new session.`),
			effort: z.string().min(1).optional().describe(`Thinking effort for this turn and after it: one of ${THINKING_LIST} that the model takes. Default: the session's, or the host's default for a new session.`),
		};
		const sandboxText = "a sandbox VM of its own: a copy of the project's last commit that reaches the internet and nothing else, holding no keys. Its commits come back to the project's sandbox/N branch";
		const worktreeText = "a git worktree of its own on a worktree/N branch, made from the project's last commit, where git push is refused; the project's checkout and its uncommitted files are never touched, and its commits stay on the branch until the user merges them";
		server.registerTool("start_session", {
			description: worktreeOnly
				? `Start a session in a project on ${options.machine} with a task, worktree-only: it always works in ${worktreeText}. read_session shows how it goes. Returns its id and branch.`
				: sandboxOnly
				? `Start a session in a project on ${options.machine} with a task, sandbox-only: it always runs in ${sandboxText}. A local session is refused. read_session shows how it goes. Returns its id.`
				: `Start a session in a project on ${options.machine} with a task. It runs on its own with full permissions in the project; read_session shows how it goes. Returns its id.`,
			inputSchema: {
				project: z.string().describe("A name from list_projects"),
				task: z.string().min(1).describe("Everything the agent needs to know; it can't see your conversation"),
				sandbox: z.boolean().optional().describe(sandboxOnly
					? "Sandbox-only here: leave it out or pass true; false is refused."
					: "Run its tools in a sandbox VM of its own: a copy of the project's last commit that reaches the internet and nothing else, holding no keys. Its commits come back with `aludra sync`."),
				worktree: z.boolean().optional().describe(worktreeOnly
					? "Worktree-only here: leave it out or pass true; false is refused."
					: `Work in ${worktreeText}.`),
				planItem: z.string().regex(PLAN_ITEM_ID).optional().describe("The id of the item in the project's docs/plan.md this session works on, as read_plan shows it. It must be in the plan; the session carries it, so the owner's apps show it against the item"),
				origin: z.string().optional().describe("An https link to where this work came from, such as the thread that asked for it; the session carries it"),
				...turnFields,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ project, task, sandbox, worktree, planItem, origin, model, effort }) => {
			const blocked = sandboxOnlyRefusal(host);
			if (blocked !== undefined) return failure(blocked);
			if (sandboxOnly && sandbox === false) return failure("this endpoint starts only sandbox sessions (mcp.sandboxOnly); leave sandbox out or pass true");
			if (worktreeOnly && worktree === false) return failure("this endpoint starts only worktree sessions (mcp.worktreeOnly); leave worktree out or pass true");
			if (worktreeOnly && sandbox === true) return failure("this endpoint starts only worktree sessions (mcp.worktreeOnly), not sandbox sessions");
			const inWorktree = worktreeOnly || worktree === true;
			if (inWorktree && sandbox === true) return failure("a session is in a sandbox or a worktree, not both");
			const agent = turnSettings(host, { model, effort }, host.model);
			if (typeof agent === "string") return failure(agent);
			const inSandbox = sandboxOnly || sandbox === true;
			let found;
			try {
				found = findProject(host.projects(), project);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			if (origin !== undefined) {
				const problem = originProblem(origin);
				if (problem !== undefined) return failure(problem);
			}
			if (planItem !== undefined) {
				try {
					const plan = await readPlan(found);
					if (!plan.exists) return failure(`${found.name} has no docs/plan.md, so it has no item ${planItem}`);
					if (!planItems(plan.text).some((item) => item.id === planItem)) return failure(`${found.name}'s docs/plan.md has no item ${planItem}; read_plan shows its items`);
				} catch (error) {
					return failure(error instanceof Error ? error.message : String(error));
				}
			}
			const source = { ...(planItem === undefined ? {} : { planItem }), ...(origin === undefined ? {} : { origin }) };
			const title = task.split("\n")[0]!.slice(0, 80);
			let session;
			try {
				session = inWorktree ? await host.sessions.createWorktree(found, title, agent, source)
					: inSandbox ? await host.sessions.createSandbox(found, title, agent, undefined, source)
					: await host.sessions.create(found, title, agent, source);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			await host.submit(session.id, task);
			return answer({ id: session.id, project: session.project, dir: session.dir, ...(session.sandbox === undefined ? {} : { sandbox: session.sandbox }), ...(session.worktree === undefined ? {} : { worktree: session.worktree, branch: worktreeBranch(session) }), ...sourceFields(session) });
		});

		server.registerTool("send_message", {
			description: `Send a session a message. While it runs, it goes in at the next tool boundary (steer) or waits until the run answers (followUp, the default).${sandboxOnly ? " Sandbox-only: a session that isn't in a sandbox is refused." : ""}${worktreeOnly ? " Worktree-only: a session that isn't in a worktree is refused." : ""}`,
			inputSchema: { id: z.number().int(), text: z.string().min(1), mode: z.enum(["followUp", "steer"]).optional(), ...turnFields },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ id, text, mode, model, effort }) => {
			const refused = await sessionRefusal(id);
			if (refused !== undefined) return failure(refused);
			try {
				if (model !== undefined || effort !== undefined) {
					const agent = turnSettings(host, { model, effort }, (await sessionAgent(host, id)).ref);
					if (typeof agent === "string") return failure(agent);
					// Set before the message goes in, so it's the turn's from its first request. A run going on would take them
					// at its next request, so they wait for one that has ended.
					if ((await host.sessions.states()).get(id) !== "idle") return failure(`session ${id} is running; send model or effort once its run has ended, or leave them out`);
					await host.configure(id, agent);
				}
				const submission = await host.submit(id, text, { steer: mode === "steer" });
				return answer({ submission: Number(submission.id) });
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		});

		server.registerTool("stop_session", {
			description: `Stop a session's run. Queued messages are dropped.${sandboxOnly ? " Sandbox-only: a session that isn't in a sandbox is refused." : ""}${worktreeOnly ? " Worktree-only: a session that isn't in a worktree is refused." : ""}`,
			inputSchema: { id: z.number().int() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		}, async ({ id }) => {
			const refused = await sessionRefusal(id);
			if (refused !== undefined) return failure(refused);
			await host.stop(id);
			return answer(`stopped session ${id}`);
		});

		server.registerTool("archive_session", {
			description: "Archive a session: list_sessions leaves it out unless includeArchived is true, and read_session still reads it. Its transcript stays, and its commits are fetched to its sandbox/N branch before its sandbox is deleted, as archiving from the apps does; a sandbox with uncommitted files is kept. A worktree session's worktree is removed and its worktree/N branch kept; one with uncommitted files is kept. Only a session that has come to rest (done, failed, stopped or idle) can be archived, not one running or waiting for approval. Sandbox and worktree sessions only: any other session is refused. Archiving one already archived changes nothing.",
			inputSchema: { id: z.number().int() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		}, async ({ id }) => {
			const refused = await archiveRefusal(id, "archive_session");
			if (refused !== undefined) return failure(refused);
			const record = (await host.sessions.get(id))!;
			if (record.archived === true) return answer({ id, title: record.title, archived: true, message: `session ${id} was already archived` });
			if (record.sandboxState === "preparing") return failure(`session ${id}'s sandbox is still being made; archive it once it's ready`);
			// Archiving a discarded session deletes its sandbox without fetching, which would lose commits made since.
			if (record.sandboxDiscarded === true && record.sandboxRemoved !== true) return failure(`session ${id}'s sandbox/N branch was discarded, so archiving would delete its sandbox without fetching its commits; archive it from the apps or the CLI instead`);
			const summary = await readSummary(host, id);
			if (summary === undefined) return failure(`No session ${id}; list_sessions lists them, with includeArchived for archived ones`);
			// The harness too, so a run that's queued but not yet in the transcript counts as running.
			const live = (await host.sessions.states()).get(id);
			if (summary.state === "running" || live === "running") return failure(`session ${id} is running, and only a session at rest (done, failed, stopped or idle) can be archived; stop_session stops it, or wait for its run to end`);
			if (summary.state === "waiting" || live === "waiting") return failure(`session ${id} is waiting for approval, and only a session at rest (done, failed, stopped or idle) can be archived; it can be archived once the approval is answered and its run ends`);
			try {
				const done = await host.sessions.archive(id, true);
				return answer({ id, title: done.title, archived: true, message: `archived session ${id}` });
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		});

		server.registerTool("unarchive_session", {
			description: "Bring an archived session back to list_sessions. It stays listed however long it sits idle, until it's archived again. A sandbox deleted or a worktree removed when it was archived doesn't come back. Sandbox and worktree sessions only: any other session is refused. Unarchiving one that isn't archived changes nothing.",
			inputSchema: { id: z.number().int() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		}, async ({ id }) => {
			const refused = await archiveRefusal(id, "unarchive_session");
			if (refused !== undefined) return failure(refused);
			const record = (await host.sessions.get(id))!;
			if (record.archived !== true) return answer({ id, title: record.title, archived: false, message: `session ${id} wasn't archived` });
			try {
				const done = await host.sessions.archive(id, false);
				return answer({ id, title: done.title, archived: false, message: `unarchived session ${id}` });
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		});
	}
	return server;
}

/** Handles one request to /mcp: a fresh server and transport each time, the JSON body read already. */
export async function handleMcp(host: Host, request: IncomingMessage, response: ServerResponse, body: unknown, options: { machine: string; token: Token }): Promise<void> {
	const server = mcpServer(host, options);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	response.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(request, response, body);
}
