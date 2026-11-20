// The MCP endpoint: aludra's sessions as tools for agents it didn't start, such as Claude Code or pi in a terminal on
// another machine, so work can be handed between machines. Streamable HTTP at POST /mcp, served by the same server as
// the API (src/api.ts) and reached the same way, through tailscale serve.
//
// Who gets in: a bearer token made with `aludra token add` (src/tokens.ts), one per agent, and a request with an Origin
// is refused, since a browser always sends one and an agent's MCP client doesn't. Not the API's Tailscale login: a
// tagged machine has none, and it names a person rather than the agent. There's no OAuth. It's stateless, a server and
// transport per request, which suits a host that restarts and clients that reconnect.
//
// Read-only unless the token's scope is write and the settings' mcp.write is true. Writing lets an agent start
// sessions, which run with every permission a session has (only git push and remote commands to approval hosts wait),
// so tokens are read-only and mcp.write is off by default; mcp.write turns writing off for every token at once.
//
// mcp.sandboxOnly narrows writing to sandboxes: start_session makes only sandbox sessions, refusing a call that asks for
// a local one rather than quietly giving it a sandbox, and send_message and stop_session refuse any session that isn't
// in one, whoever started it. Without a sandbox host every write tool refuses, so nothing falls back to a local
// session. No tool here syncs or merges; what a run's end does to the checkout is sandboxes.afterRun's. ship_session,
// behind mcp.ship and mcp.shipWorktrees, pushes a session's work to the upstream (src/ship.ts).
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
//
// start_session without a project makes a scratch session, always in a sandbox whatever mcp.sandboxOnly says: its
// sandbox starts from the empty repository every scratch session shares, and its commits come back to a repository of
// its own in the data directory (host.sessions.startSandbox with no project). It touches no project and no GitHub, so
// it needs nothing beyond mcp.write and a sandbox host. A local scratch session, as the apps can make, isn't offered,
// and neither is one in a worktree: under mcp.worktreeOnly, or with worktree: true, a call without a project is refused.
//
// create_project and promote_session, with mcp.allowNewProjects as well, ask to make a project, empty or from a scratch
// sandbox session's work (host.newProjects). They're registered only with it on, as the write tools are only with
// mcp.write, so a client with it off isn't offered tools that always refuse; the instructions say it's off. Nothing is
// made when they're called: an MCP call can't wait for a person, so each stores a request (src/project-requests.ts) and
// answers that it's pending, and the owner approves or denies it with the other approvals (aludra approve, POST
// /api/approvals/:id), told by a push notification. Approving makes it on the host; the agent calls again with the
// same arguments for the outcome. They refuse before storing anything when newProjects isn't set or gh can't make
// repositories, and promote_session a session that isn't a scratch sandbox or isn't at rest. Under mcp.worktreeOnly
// promote_session isn't registered, since that mode has no scratch sandbox sessions to act on; create_project is.
//
// write_plan, with mcp.writePlans as well, replaces a project's docs/plan.md in its checkout (src/plans.ts's writePlan),
// the one write that reaches the checkout under mcp.sandboxOnly and mcp.worktreeOnly, since a plan is the file a planning
// chat needs to change. It takes the sha256 read_plan gave as base and refuses when the file has changed since, and
// refuses a plan that isn't in the standard format or drops an id. It stages and commits nothing.
//
// check_sessions and mark_sessions_handled are a gate for an agent that wakes on sessions changing without a model
// running (Lan's): check_sessions answers { wake, data, topic } and moves nothing, mark_sessions_handled moves the
// calling token's cursor (src/session-changes.ts). Both are reading tools, since a cursor is only that token's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Item } from "./api-types.ts";
import type { Host } from "./host.ts";
import type { Thinking } from "./config.ts";
import type { Scope, Token } from "./tokens.ts";
import { prose, parseSaid } from "./results.ts";
import { readSummary } from "./live.ts";
import { findProject } from "./projects.ts";
import { checkName } from "./new-projects.ts";
import { describeProjectRequest, type ProjectRequest } from "./project-requests.ts";
import { context, isSandboxSession, isWorktreeSession, worktreeBranch } from "./host.ts";
import { itemsOf } from "./transcript.ts";
import { shipLine, ShipRefused } from "./ship.ts";
import type { SessionRecord } from "./host.ts";
import { PlanConflict, PlanInvalid, readPlan, writePlan } from "./plans.ts";

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

/** The last non-empty line of an answer's prose, without Markdown's marks, cut to 300 characters. */
function lastLine(text: string): string {
	const line = prose(text).split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^(`{3,}|~{3,})/.test(l)).at(-1) ?? "";
	const plain = line.replace(/[*_`#>]/g, "").trim();
	return plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
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

/** What check_sessions tells a gate: whether to wake, an entry per changed session, and the newest change in a line. */
export async function checkSessions(host: Host, token: Pick<Token, "id" | "createdAt">) {
	const records = await host.sessions.list();
	const byId = new Map(records.map((r) => [r.id, r]));
	const summaries = new Map((await Promise.all(records.map((r) => readSummary(host, r.id)))).filter((s) => s !== undefined).map((s) => [s.id, s]));
	// A ship's push comes after the session's ship turn has ended, so its landing or stopping counts as the session
	// changing: an agent waiting on a ship hears how it went.
	const changedAt = (id: number, updatedAt: number) => Math.max(updatedAt, byId.get(id)?.shipped?.at ?? 0, byId.get(id)?.shipStopped?.at ?? 0);
	host.sessionChanges.observe([...summaries.values()].map((s) => ({ id: s.id, state: s.state, updatedAt: changedAt(s.id, s.updatedAt) })));
	// One entry per session: from the state before its first unhandled change to its latest.
	const bySession = new Map<number, { change: number; from: string | null; to: string }>();
	for (const c of host.sessionChanges.pending(token.id, token.createdAt.getTime())) {
		const before = bySession.get(c.session);
		bySession.set(c.session, { change: c.change, from: before === undefined ? c.from : before.from, to: c.to });
	}
	const data = [];
	for (const [id, c] of bySession) {
		const summary = summaries.get(id);
		if (summary === undefined) continue;
		const state = await (await host.conversation(id)).viewState(context);
		let agent = "";
		let question: { text: string; options: string[] } | undefined;
		let settings: ReturnType<typeof agentOf>;
		try {
			settings = agentOf(host, state.value);
			const answer = itemsOf(state.value).findLast((item) => item.kind === "answer" && item.streaming !== true);
			if (answer?.kind === "answer") {
				agent = lastLine(answer.text);
				const asked = parseSaid(answer.text).question;
				if (asked !== undefined) question = { text: asked.text, options: asked.options ?? [] };
			}
		} finally {
			state.dispose();
		}
		data.push({
			change: c.change,
			id,
			project: summary.project,
			title: summary.title,
			from: c.from,
			to: c.to,
			transition: `${c.from ?? "new"} → ${c.to}`,
			state: summary.state,
			updated: new Date(summary.updatedAt).toISOString(),
			line: summary.line,
			model: settings.model,
			effort: settings.effort,
			agent,
			...(question === undefined ? {} : { question }),
			...(summary.sandbox === undefined ? {} : { sandbox: summary.sandbox }),
			...(summary.archived === true ? { archived: true } : {}),
			...shipField(byId.get(id)),
		});
	}
	data.sort((a, b) => a.change - b.change);
	const newest = data.at(-1);
	const topic = newest === undefined ? "" : `${newest.project} #${newest.id} ${newest.title}: ${newest.transition}${data.length > 1 ? ` (+${data.length - 1} more)` : ""}`;
	// A gate's data is text (Lan reads { wake: boolean, data?: string, topic?: string }), so the entries go as JSON text.
	return { wake: data.length > 0, ...(data.length === 0 ? {} : { data: JSON.stringify(data, null, 2) }), topic, ...(newest === undefined ? {} : { through: newest.change }) };
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
	// Worktree-only has no scratch sessions, since a worktree needs a project, so nothing there can be promoted.
	const projectsText = refusal !== undefined ? ""
		: worktreeOnly
			? host.mcpAllowNewProjects()
				? " Every session here needs a project. create_project asks to make an empty project; it waits for the owner's approval, so call again with the same arguments for the answer."
				: " Every session here needs a project. Making projects is off here (mcp.allowNewProjects)."
		: host.mcpAllowNewProjects()
			? " A session with no project is a scratch session in a sandbox, for a new idea. create_project asks to make an empty project and promote_session asks to make a scratch session's work one; both wait for the owner's approval, so call again with the same arguments for the answer."
			: " A session with no project is a scratch session in a sandbox, for a new idea. Making projects is off here (mcp.allowNewProjects); the owner can make one from a scratch session's work.";
	const server = new McpServer({ name: `aludra on ${options.machine}`, version: "1.0.0" }, {
		instructions: `aludra runs coding-agent sessions on ${options.machine}, each in a project directory there. List projects and sessions, read a session's transcript, and search what was said. ${writing}${projectsText}`,
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
		return answer(shown.map((s, i) => ({ id: s.id, project: s.project, title: s.title, state: s.state, line: s.line, updated: new Date(s.updatedAt).toISOString(), model: agents[i]!.model, effort: agents[i]!.effort, ...(s.archived === true ? { archived: true } : {}), ...shipField(shipRecords[i]) })));
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
			const ship = shipOf(await host.sessions.get(id));
			const shipped = ship === undefined ? "" : `Ship: ${"shipping" in ship ? "shipping" : ship.line}\n`;
			const header = `Session ${id}: ${summary.title}\nProject: ${summary.project} (${summary.dir})\nState: ${summary.state}\nModel: ${model}\nEffort: ${effort}\n${shipped}\n`;
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

	server.registerTool("check_sessions", {
		description: "A gate for waking on session changes: { wake, data, topic }. wake is true when a session is new, or has come to rest (done, failed, stopped, waiting, idle) since this token last called mark_sessions_handled. data has an entry per changed session: change (its number), id, project, title, from and to states, updated, line, the agent's last line, and the question it asks with options when it asks one. topic is the newest change in a line. Moves nothing: call mark_sessions_handled with the change you've handled through.",
		annotations: readOnly,
	}, async () => answer(await checkSessions(host, options.token)));

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

	server.registerTool("mark_sessions_handled", {
		description: "Marks the session changes check_sessions gave up to and including change `through` handled, for this token only; other clients keep their own place. It never moves back.",
		inputSchema: { through: z.number().int().min(0).describe("A change number from check_sessions, usually the largest") },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, async ({ through }) => answer(host.sessionChanges.markHandled(options.token.id, through)));

	if (refusal === undefined) {
		const turnFields = {
			model: z.string().min(1).optional().describe(`The model for this turn and the session's turns after it: one of ${host.choices().map((c) => c.id).join(", ")}, or provider/id. Default: the session's model, or the host's default for a new session.`),
			effort: z.string().min(1).optional().describe(`Thinking effort for this turn and after it: one of ${THINKING_LIST} that the model takes. Default: the session's, or the host's default for a new session.`),
		};
		const sandboxText = "a sandbox VM of its own: a copy of the project's last commit that reaches the internet and nothing else, holding no keys. Its commits come back to the project's sandbox/N branch";
		const worktreeText = "a git worktree of its own on a worktree/N branch, made from the project's last commit, where git push is refused; the project's checkout and its uncommitted files are never touched, and its commits stay on the branch until the user merges them";
		const scratchText = "Without a project it's a scratch session: it runs in a sandbox VM of its own, starting from an empty repository, and its commits come back to a repository of its own on this machine, not to any project.";
		server.registerTool("start_session", {
			description: worktreeOnly
				? `Start a session in a project on ${options.machine} with a task, worktree-only: it always works in ${worktreeText}. read_session shows how it goes. Returns its id and branch.`
				: sandboxOnly
				? `Start a session in a project on ${options.machine} with a task, sandbox-only: it always runs in ${sandboxText}. A local session is refused. ${scratchText} read_session shows how it goes. Returns its id.`
				: `Start a session in a project on ${options.machine} with a task. It runs on its own with full permissions in the project; read_session shows how it goes. ${scratchText} Returns its id.`,
			inputSchema: {
				project: z.string().optional().describe(worktreeOnly
					? "A name from list_projects. Worktree-only here: a project is required, since a worktree needs one and a session with no project is a sandbox"
					: "A name from list_projects. Leave it out for a scratch session in no project, which always runs in a sandbox: for a new idea that has no project yet"),
				task: z.string().min(1).describe("Everything the agent needs to know; it can't see your conversation"),
				sandbox: z.boolean().optional().describe(sandboxOnly
					? "Sandbox-only here: leave it out or pass true; false is refused."
					: "Run its tools in a sandbox VM of its own: a copy of the project's last commit that reaches the internet and nothing else, holding no keys. Its commits come back with `aludra sync`."),
				worktree: z.boolean().optional().describe(worktreeOnly
					? "Worktree-only here: leave it out or pass true; false is refused."
					: `Work in ${worktreeText}.`),
				...turnFields,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ project, task, sandbox, worktree, model, effort }) => {
			const blocked = sandboxOnlyRefusal(host);
			if (blocked !== undefined) return failure(blocked);
			if (sandboxOnly && sandbox === false) return failure("this endpoint starts only sandbox sessions (mcp.sandboxOnly); leave sandbox out or pass true");
			if (worktreeOnly && worktree === false) return failure("this endpoint starts only worktree sessions (mcp.worktreeOnly); leave worktree out or pass true");
			if (worktreeOnly && sandbox === true) return failure("this endpoint starts only worktree sessions (mcp.worktreeOnly), not sandbox sessions");
			// A scratch session is always a sandbox one and a worktree needs a project, so worktree-only has no scratch session.
			if (worktreeOnly && project === undefined) return failure("this endpoint starts only worktree sessions (mcp.worktreeOnly), and a worktree needs a project; name one from list_projects");
			const inWorktree = worktreeOnly || worktree === true;
			if (inWorktree && sandbox === true) return failure("a session is in a sandbox or a worktree, not both");
			// A scratch session is a sandbox one, so it never makes a local scratch directory session as the apps can.
			if (project === undefined && worktree === true) return failure("a session with no project runs only in a sandbox, and a worktree needs a project; leave worktree out, or name a project from list_projects");
			if (project === undefined && sandbox === false) return failure("a session with no project runs only in a sandbox; leave sandbox out or pass true, or name a project from list_projects for a local session");
			if (project === undefined && host.sandboxSettings() === undefined) return failure("a session with no project runs in a sandbox, and the settings name no sandbox host (sandboxes); name a project from list_projects");
			const agent = turnSettings(host, { model, effort }, host.model);
			if (typeof agent === "string") return failure(agent);
			const inSandbox = sandboxOnly || sandbox === true || project === undefined;
			let found;
			try {
				found = project === undefined ? undefined : findProject(host.projects(), project);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const title = task.split("\n")[0]!.slice(0, 80);
			let session;
			try {
				session = inWorktree ? await host.sessions.createWorktree(found!, title, agent)
					: inSandbox ? await host.sessions.createSandbox(found, title, agent)
					: await host.sessions.create(found!, title, agent);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			await host.submit(session.id, task);
			return answer({ id: session.id, project: session.project, dir: session.dir, ...(session.sandbox === undefined ? {} : { sandbox: session.sandbox }), ...(session.worktree === undefined ? {} : { worktree: session.worktree, branch: worktreeBranch(session) }), ...(session.scratch === true ? { scratch: true } : {}) });
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

		const shipSandboxes = host.mcpShip();
		const shipWorktrees = host.mcpShipWorktrees();
		if (shipSandboxes || shipWorktrees) {
			const where = host.shipMode() === "main" ? "to the upstream branch" : "to a branch of its own with a pull request";
			const kinds = [
				...(shipSandboxes ? [`A sandbox session commits what's left and rebases onto the project's upstream branch in its sandbox, then ${options.machine} runs the project's declared checks there and pushes it ${where}, from ${options.machine}, so the sandbox never holds a key.`] : []),
				...(shipWorktrees ? [`A worktree session commits what's left and rebases its worktree/N branch onto the project's upstream branch in its worktree, then ${options.machine} runs the project's declared checks in the worktree and pushes it ${where} from the project's checkout on ${options.machine}, with the owner's git login; the session itself still can't push. Ask the owner before each ship.`] : []),
			];
			const which = shipSandboxes && shipWorktrees ? "a sandbox or worktree session" : shipSandboxes ? "a sandbox session" : "a worktree session";
			server.registerTool("ship_session", {
				description: `Ship ${which}'s work. ${kinds.join(" ")} A check that fails with the work and passes without it stops the ship with nothing pushed; one that fails without the work too doesn't, and the outcome says so. Answers at once with started; how it went comes as the session changing in check_sessions, and in list_sessions and read_session, as ship: { shipped, line, ... }. Only ${which} at rest that isn't shipping already.`,
				inputSchema: { id: z.number().int(), note: z.string().max(4000).optional().describe("Told to the session first, such as which side of a conflict to keep") },
				annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			}, async ({ id, note }) => {
				const record = await host.sessions.get(id);
				if (record === undefined) return failure(`No session ${id}; list_sessions lists them`);
				if (isWorktreeSession(record)) {
					if (!shipWorktrees) return failure(`session ${id} is in a worktree, and this host ships only sandbox sessions over MCP (mcp.shipWorktrees is off)`);
				} else if (!isSandboxSession(record)) return failure(`session ${id} isn't in ${shipSandboxes && shipWorktrees ? "a sandbox or a worktree" : shipSandboxes ? "a sandbox" : "a worktree"}, and only ${which}'s work ships`);
				else if (!shipSandboxes) return failure(`session ${id} is in a sandbox, and this host ships only worktree sessions over MCP (mcp.ship is off)`);
				try {
					const started = await host.ships.start(id, { mode: host.shipMode(), ...(note === undefined ? {} : { note }) });
					// Its result is recorded on the session; nothing here waits for it.
					void started.done.catch(() => undefined);
					return answer({ id, started: true, to: host.shipMode() });
				} catch (error) {
					if (error instanceof ShipRefused) return failure(error.message);
					throw error;
				}
			});
		}

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

		if (host.mcpWritePlans()) {
			const confined = sandboxOnly ? " This writes the project's real checkout on this machine, not a sandbox, even though sessions here are sandbox-only." : worktreeOnly ? " This writes the project's real checkout on this machine, not a worktree, even though sessions here are worktree-only." : "";
			server.registerTool("write_plan", {
				description: `Replace a project's plan, docs/plan.md, in its checkout on ${options.machine} with text, the whole new file. Pass as base the sha256 read_plan gave for the text you edited, or null to make a plan where there's none; when the file has changed since, nothing is written and the error says to read it again. The text must be in the standard plan format: exactly the sections ## Now, ## Next, ## Questions, ## Later and ## Done in that order; each item a "### <id>: <title>" heading with a unique lowercase kebab-case id and a status line under it starting "Kind:" and one of step, question, request, chore; every bare id in Needs an item in the file. No id the file has may go: move a dropped item to Done with a line saying why. A plan that breaks a rule isn't written, and the error lists every problem. It writes the working copy only and stages and commits nothing.${confined} Answers { project, path, sha256, size, modified, items: { added, removed, moved, changed } } with item ids; the sha256 is the base for the next write.`,
				inputSchema: {
					project: z.string().describe("A name from list_projects"),
					text: z.string().describe("The whole new docs/plan.md"),
					base: z.string().regex(/^[0-9a-f]{64}$/).nullable().describe("read_plan's sha256 for the text this edits, or null when the project has no plan"),
				},
				annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
			}, async ({ project, text, base }) => {
				try {
					return answer(await writePlan(findProject(host.projects(), project), text, base));
				} catch (error) {
					if (error instanceof PlanConflict || error instanceof PlanInvalid) return failure(error.message);
					return failure(error instanceof Error ? error.message : String(error));
				}
			});
		}

		if (host.mcpAllowNewProjects()) {
			/** Why no project can be asked for now, or undefined: newProjects missing, or gh not signed in. */
			const newProjectsRefusal = async (): Promise<string | undefined> => {
				const info = await host.newProjects.info();
				if (!("reason" in info)) return undefined;
				return info.reason === "newProjects isn't set"
					? "this host can't make projects: newProjects isn't set in the settings file (newProjects.root and newProjects.owner)"
					: `this host can't make projects: ${info.reason}`;
			};
			/** What a stored request answers: pending, the project made, or why there's none (an error, told once). */
			const requestAnswer = (request: ProjectRequest): Answer => {
				const base = { request: request.id, status: request.status, name: request.name, ...(request.session === undefined ? {} : { session: request.session }) };
				switch (request.status) {
					case "pending":
					case "approved":
						return answer({ ...base, status: "pending", message: `waiting for the owner's approval (aludra approve ${request.id}), until ${new Date(request.expiresAt).toISOString()}; nothing is made until then. Call this tool again with the same arguments to learn the answer` });
					case "done": {
						const project = host.projects().find((p) => p.dir === request.dir);
						return answer({ ...base, project: { name: project?.name ?? request.name, workspace: project?.workspace, dir: request.dir }, message: request.kind === "create" ? `made project ${request.name}; start_session can use it now` : `session ${request.session}'s work is project ${request.name} now, and the session that project's sandbox session` });
					}
					default: {
						host.projectRequests.report(request);
						const why = request.status === "denied" ? "the owner denied it, and nothing was made"
							: request.status === "expired" ? "the owner didn't answer in time, and nothing was made"
							: `the owner approved it, but it couldn't be made: ${request.error}`;
						return failure(`request ${request.id} to ${describeProjectRequest(request)}: ${why}. Calling again asks again`);
					}
				}
			};
			/** Token's latest request for these, unless it ended and the agent was told: then asking again is a new one. */
			const standing = (kind: "create" | "promote", name: string, session?: number) => {
				const found = host.projectRequests.find(options.token.id, kind, name, session);
				return found === undefined || host.projectRequests.spent(found) ? undefined : found;
			};
			const approvalText = "Nothing is made until the owner approves it: the call stores a request and answers { request, status: \"pending\" } at once. Call again with the same arguments to learn the answer: the project once it's made, or an error when the owner denied it, didn't answer within the approval wait, or it couldn't be made.";
			const nameField = z.string().describe("The project's folder and GitHub repository name: lowercase letters, digits and -, starting with a letter or digit");
			const descriptionField = z.string().optional().describe("A line about the project, for its README and GitHub repository");

			server.registerTool("create_project", {
				description: `Ask to make a new, empty project on ${options.machine}: a folder in the host's new-projects root with a README and a first commit, and a private GitHub repository it's pushed to. ${approvalText} For an idea with work to keep, start_session without a project and promote_session it instead.`,
				inputSchema: { name: nameField, description: descriptionField },
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			}, async ({ name, description }) => {
				const asked = standing("create", name);
				if (asked !== undefined) return requestAnswer(asked);
				try {
					checkName(name);
				} catch (error) {
					return failure(error instanceof Error ? error.message : String(error));
				}
				const unready = await newProjectsRefusal();
				if (unready !== undefined) return failure(unready);
				if (host.projects().some((p) => p.name === name)) return failure(`there's a project named ${name} already; list_projects lists them`);
				return requestAnswer(host.projectRequests.open(options.token.id, "create", name, description));
			});

			// Not under worktreeOnly: it takes only a scratch sandbox session, which that mode neither makes nor acts on.
			if (!worktreeOnly) {
				server.registerTool("promote_session", {
					description: `Ask to make a scratch session's work a new project on ${options.machine}: its sandbox's commits become the project's main, pushed to a new private GitHub repository, and the session becomes that project's sandbox session. Only a scratch session (start_session without a project) that has come to rest (done, failed, stopped or idle) with its work committed. ${approvalText}${sandboxOnly ? " Sandbox-only: a session that isn't in a sandbox is refused." : ""}`,
					inputSchema: { id: z.number().int().describe("A scratch session's id"), name: nameField, description: descriptionField },
					annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
				}, async ({ id, name, description }) => {
					const asked = standing("promote", name, id);
					if (asked !== undefined) return requestAnswer(asked);
					const refused = await sessionRefusal(id);
					if (refused !== undefined) return failure(refused === `No session ${id}` ? `No session ${id}; list_sessions lists them` : refused);
					const record = (await host.sessions.get(id))!;
					if (record.scratch !== true || !isSandboxSession(record)) return failure(`session ${id} isn't a scratch sandbox session, and only one is made a project; start_session without a project makes one`);
					if (record.sandboxState === "preparing") return failure(`session ${id}'s sandbox is still being made; ask once its run has ended`);
					if (record.sandbox === undefined || record.sandboxRemoved === true) return failure(`session ${id}'s sandbox isn't there to take the work from`);
					const summary = await readSummary(host, id);
					const live = (await host.sessions.states()).get(id);
					if (summary?.state === "running" || live === "running") return failure(`session ${id} is running, and only a session at rest (done, failed, stopped or idle) is made a project; wait for its run to end`);
					if (summary?.state === "waiting" || live === "waiting") return failure(`session ${id} is waiting for approval, and only a session at rest (done, failed, stopped or idle) is made a project`);
					try {
						checkName(name);
					} catch (error) {
						return failure(error instanceof Error ? error.message : String(error));
					}
					const unready = await newProjectsRefusal();
					if (unready !== undefined) return failure(unready);
					if (host.projects().some((p) => p.name === name)) return failure(`there's a project named ${name} already; list_projects lists them`);
					return requestAnswer(host.projectRequests.open(options.token.id, "promote", name, description, id));
				});
			}
		}
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
