// `aludra serve`: owns the SQLite file and runs the sessions. The CLI talks to it over a Unix socket in the data
// directory, one JSON object per line, one request per connection (after gaidin's server.ts).
//
// client → server: {"type":"ask","content":"...","project":"aludra"} or {"type":"ask","content":"...","session":3},
//                  {"type":"watch","session":3?}, {"type":"sessions","listing":true?}, {"type":"stop","session":3},
//                  {"type":"approvals"}, {"type":"decide","id":"3f9a1c","allow":true}, {"type":"live"},
//                  {"type":"retitle"}, {"type":"archive","session":3,"archived":true},
//                  {"type":"settings","changes":{"approvals.hosts":["db"]}?}
// server → client: {"type":"line","text":"..."}, for a sessions request with listing
//                  {"type":"sessions","sessions":[SessionSummary...],"colors":{...}}, for a settings request
//                  {"type":"settings","settings":Settings}, and, last, {"type":"done","status":"..."}
//
// `listing` asks for the sessions as data, which the CLI lays out for its terminal (src/listing.ts); a host from before
// it ignores the field and sends lines, which the CLI prints as they are.
//
// `live` keeps the connection open for the terminal UI (src/tui.ts): the server sends {"type":"event","event":...} with
// each ServerEvent the web app gets over /api/live (src/live.ts), and the client may send ClientEvent follows on the
// same connection, one per line: {"type":"follow","session":3} or {"type":"follow","session":null}.
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type AgentEvent, AssistantEntry, type EntryId, type EntryRecord, watchEvents } from "@earendil-works/pi-durable";
import type { ServerEvent, SessionSummary, Settings } from "./api-types.ts";
import { createApi } from "./api.ts";
import { createLive, type Live, monthSpend, readSummary } from "./live.ts";
import { scheduleBackups } from "./backup.ts";
import { createPush, loadPushKeys } from "./push.ts";
import type { Config } from "./config.ts";
import { context, conversationId, type Host, openHost, type SessionRecord } from "./host.ts";
import { array, boolean, dictionary, integer, type Json, jsonObject, literal, nullable, number, object, optional, ParseError, parseJson, string } from "./parse.ts";
import type { ApprovalRequest } from "./permissions.ts";
import { findProject } from "./projects.ts";

export const socketPathFor = (config: Config) => resolve(config.dataDir, "aludra.sock");

export type ClientMessage =
	| { type: "ask"; content: string; project?: string; session?: number; requestId?: string; steer?: boolean }
	| { type: "watch"; session?: number }
	| { type: "sessions"; listing?: boolean }
	| { type: "stop"; session: number }
	| { type: "approvals" }
	| { type: "decide"; id: string; allow: boolean }
	| { type: "live" }
	| { type: "retitle" }
	| { type: "archive"; session: number; archived: boolean }
	/** The settings, after making `changes` if there are any (src/settings.ts). */
	| { type: "settings"; changes?: { readonly [key: string]: Json } };

export type ServerMessage =
	| { type: "line"; text: string }
	| { type: "sessions"; sessions: SessionSummary[]; colors: Record<string, number>; spend?: { month: number } }
	| { type: "settings"; settings: Settings }
	| { type: "event"; event: ServerEvent }
	| { type: "done"; status: string };

const followEvent = object({ type: literal("follow"), session: nullable(integer) });
const clientMessage = object({
	type: literal("ask", "watch", "sessions", "stop", "approvals", "decide", "live", "retitle", "archive", "settings"),
	changes: optional(jsonObject),
	archived: optional(boolean),
	content: optional(string),
	project: optional(string),
	session: optional(integer),
	requestId: optional(string),
	steer: optional(boolean),
	id: optional(string),
	allow: optional(boolean),
	listing: optional(boolean),
});
const summary = object({
	id: integer,
	workspace: string,
	project: string,
	dir: string,
	title: string,
	createdAt: number,
	updatedAt: number,
	state: literal("running", "waiting", "failed", "stopped", "done", "idle"),
	line: string,
	cost: optional(number),
});
const serverMessage = object({
	type: literal("line", "sessions", "settings", "event", "done"),
	event: optional(jsonObject),
	settings: optional(jsonObject),
	text: optional(string),
	status: optional(string),
	sessions: optional(array(summary)),
	colors: optional(dictionary(integer)),
	spend: optional(object({ month: number })),
});

export function parseClientMessage(line: string): ClientMessage {
	const m = parseJson(line, clientMessage, "the request");
	switch (m.type) {
		case "ask":
			if (m.content === undefined) throw new ParseError("an ask needs content");
			if ((m.project === undefined) === (m.session === undefined)) throw new ParseError("an ask needs a project or a session");
			return { type: "ask", content: m.content, ...(m.project === undefined ? {} : { project: m.project }), ...(m.session === undefined ? {} : { session: m.session }), ...(m.requestId === undefined ? {} : { requestId: m.requestId }), ...(m.steer === undefined ? {} : { steer: m.steer }) };
		case "watch":
			return m.session === undefined ? { type: "watch" } : { type: "watch", session: m.session };
		case "sessions":
			return m.listing === true ? { type: "sessions", listing: true } : { type: "sessions" };
		case "stop":
			if (m.session === undefined) throw new ParseError("a stop needs a session");
			return { type: "stop", session: m.session };
		case "live":
			return { type: "live" };
		case "retitle":
			return { type: "retitle" };
		case "archive":
			if (m.session === undefined) throw new ParseError("an archive needs a session");
			return { type: "archive", session: m.session, archived: m.archived !== false };
		case "settings":
			return m.changes === undefined ? { type: "settings" } : { type: "settings", changes: m.changes };
		case "decide":
			if (m.id === undefined || m.allow === undefined) throw new ParseError("a decision needs an id and allow");
			return { type: "decide", id: m.id, allow: m.allow };
		default:
			return { type: m.type };
	}
}

export function parseServerMessage(line: string): ServerMessage {
	const m = parseJson(line, serverMessage, "the server's message");
	// SAFETY: the host on our own socket sends the ServerEvents src/live.ts makes.
	if (m.type === "event") return { type: "event", event: m.event as unknown as ServerEvent };
	// SAFETY: the host on our own socket sends the Settings src/settings.ts makes.
	if (m.type === "settings") return { type: "settings", settings: m.settings as unknown as Settings };
	if (m.type === "sessions") return { type: "sessions", sessions: m.sessions ?? [], colors: Object.fromEntries(m.colors ?? []), ...(m.spend === undefined ? {} : { spend: m.spend }) };
	return m.type === "line" ? { type: "line", text: m.text ?? "" } : { type: "done", status: m.status ?? "" };
}

/** Whether a server answers on the socket. */
export function isListening(path: string): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const probe = connect(path);
		probe.once("connect", () => {
			probe.end();
			resolvePromise(true);
		});
		probe.once("error", () => resolvePromise(false));
	});
}

function send(socket: Socket, message: ServerMessage) {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** An answer's text, or its failure: a refusal, an error from the bridge, a stop. */
export function describeAnswer(entry: EntryRecord | undefined): string | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason === "error") return `! ${message.errorMessage ?? "the model failed without saying why"}`;
	if (message.stopReason === "aborted") return "· stopped";
	const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
	return text === "" ? undefined : text;
}

/** One line per thing a session does. */
export function describe(event: AgentEvent): string | undefined {
	switch (event.type) {
		case "tool_execution_start": {
			const { command, path } = event.args;
			const what = typeof command === "string" ? command : typeof path === "string" ? path : JSON.stringify(event.args);
			return `· ${event.toolName} ${clip(what)}`;
		}
		case "message_end":
			return describeAnswer(event.entry);
		case "auto_retry_start":
			return `· retrying (attempt ${event.attempt}): ${clip(event.errorMessage)}`;
		case "compaction_start":
			return `· compacting (${event.reason})`;
		case "compaction_end":
			return "· compacted";
		case "task_failed":
			return `! ${event.kind}: ${event.message}`;
		default:
			return undefined;
	}
}

export function describeApproval(request: ApprovalRequest): string {
	if (request.status === "pending") return `? ${request.summary} waits for approval: ${clip(request.command)}\n  aludra approve ${request.id}   or   aludra deny ${request.id}`;
	return `· approval ${request.id} (${request.summary}): ${request.status}`;
}

const age = (ms: number) => {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** Sessions grouped by project, with their state. */
export function describeSessions(sessions: readonly SessionRecord[], states: ReadonlyMap<number, string>, now = Date.now()): string[] {
	if (sessions.length === 0) return ['no sessions yet; start one with aludra ask --project NAME "..."'];
	const groups = new Map<string, SessionRecord[]>();
	for (const session of sessions) groups.set(`${session.project} (${session.workspace})`, [...(groups.get(`${session.project} (${session.workspace})`) ?? []), session]);
	return [...groups].flatMap(([name, group]) => [
		name,
		...group.map((s) => `  ${String(s.id).padStart(4)}  ${(states.get(s.id) ?? "idle").padEnd(7)}  ${age(now - s.createdAt).padStart(4)}  ${s.title}`),
	]);
}

export async function serve(config: Config) {
	const socketPath = socketPathFor(config);
	if (await isListening(socketPath)) {
		console.error(`aludra is already running on ${socketPath}`);
		process.exit(1);
	}
	const watchers = new Set<Socket>();
	const host = await openHost({
		config,
		onNotice: (notice) => {
			console.error(`[bridge ${notice.level}] ${notice.message}`);
			for (const socket of watchers) send(socket, { type: "line", text: `! ${notice.message}` });
		},
	});
	host.resume();
	// One live feed for the app's socket and the terminal UI's.
	const live = createLive(host);
	const server = listen(host, socketPath, watchers, live);
	console.error(`aludra listening on ${socketPath}, model ${host.model.provider}/${host.model.modelId}`);
	const stopBackups = scheduleBackups(config);
	const push = createPush({ harness: host.harness, keys: loadPushKeys(config.dataDir) });
	const { users } = config.api;
	const api = users.length === 0 ? undefined : createApi(host, { users, push, live });
	if (api === undefined) console.error("no api.users in the settings, so the app's API is off");
	// Loopback only: tailscale serve is the way in, and it vouches for who's asking.
	else api.listen(config.api.port, () => console.error(`aludra app and API on 127.0.0.1:${config.api.port}, for ${users.join(", ")}`));

	async function shutdown() {
		stopBackups();
		await api?.close();
		server.close();
		for (const socket of watchers) socket.destroy();
		live.close();
		await host.close();
		process.exit(0);
	}
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

/**
 * Serves the protocol above for `host` on `socketPath`. `watchers` are the sockets that hear the bridge's notices, and
 * `live` the feed the terminal UI gets; one is made when the first UI connects if none is given.
 */
export function listen(host: Host, socketPath: string, watchers = new Set<Socket>(), live?: Live) {
	const line = (socket: Socket, text: string) => send(socket, { type: "line", text });

	/** Sends `socket` a line for everything session `id` does, prefixed with `prefix`, until it closes. Resolves once attached. */
	async function follow(socket: Socket, id: number, prefix: string) {
		const shown = new Set<EntryId>();
		const events = await watchEvents(host.harness, conversationId(id), context);
		events.start(async (batch) => {
			for (const event of batch) {
				const text = describe(event);
				if (text === undefined) continue;
				if (event.type === "message_end") shown.add(event.entry.id);
				line(socket, `${prefix}${text}`);
			}
		});
		const unsubscribe = host.approvals.onChange((request) => {
			if (request.conversationId === id) line(socket, `${prefix}${describeApproval(request)}`);
		});
		socket.once("close", () => {
			unsubscribe();
			void events.stop();
		});
		return { events, shown };
	}

	async function ask(socket: Socket, request: Extract<ClientMessage, { type: "ask" }>) {
		let id = request.session;
		if (request.project !== undefined) {
			const session = await host.sessions.create(findProject(host.projects(), request.project), request.content);
			id = session.id;
			line(socket, `session ${id} in ${session.project} (${session.dir})`);
		}
		const { events, shown } = await follow(socket, id!, "");
		const requestId = request.requestId ?? randomUUID();
		const submission = await host.submit(id!, request.content, { requestId, steer: request.steer === true });
		// If the client goes away, the run goes on; only this wait and its watch end.
		const settled = await submission.wait(context);
		await events.stop();
		// A client reattaching to a run that finished without it still gets the answer.
		if (settled.status === "done" && settled.type === "input" && !shown.has(settled.answer)) {
			const text = describeAnswer(await host.harness.commit((tx) => tx.entry(settled.answer), context));
			if (text !== undefined) line(socket, text);
		}
		if (settled.status === "unanswered") line(socket, `! no answer (${settled.reason ?? "unknown reason"})`);
		send(socket, { type: "done", status: settled.status });
		socket.end();
	}

	async function watch(socket: Socket, session: number | undefined) {
		if (session !== undefined) {
			await host.conversation(session);
			await follow(socket, session, "");
			return;
		}
		watchers.add(socket);
		socket.once("close", () => watchers.delete(socket));
		const attach = (s: SessionRecord) => follow(socket, s.id, `[${s.id} ${s.project}] `);
		const stopCreated = host.sessions.onCreate((s) => {
			line(socket, `[${s.id} ${s.project}] · new session: ${s.title}`);
			void attach(s);
		});
		socket.once("close", stopCreated);
		for (const s of await host.sessions.list()) await attach(s);
		for (const request of await host.approvals.pending()) line(socket, `[${request.conversationId}] ${describeApproval(request)}`);
	}

	async function handle(socket: Socket, text: string) {
		const request = parseClientMessage(text);
		const finish = (lines: string[], status = "done") => {
			for (const l of lines) line(socket, l);
			send(socket, { type: "done", status });
			socket.end();
		};
		switch (request.type) {
			case "ask":
				return ask(socket, request);
			case "watch":
				return watch(socket, request.session);
			case "sessions": {
				if (request.listing !== true) return finish(describeSessions(await host.sessions.list(), await host.sessions.states()));
				const sessions = (await Promise.all((await host.sessions.list()).map((s) => readSummary(host, s.id)))).flatMap((s) => (s === undefined ? [] : [s]));
				// This calendar month's spend on billed providers, from sessions that ever used one.
				const billed = sessions.filter((s) => s.cost !== undefined).map((s) => s.id);
				const spend = billed.length === 0 ? {} : { spend: { month: await monthSpend(host, billed) } };
				send(socket, { type: "sessions", sessions, colors: await host.colors.list(), ...spend });
				return finish([]);
			}
			case "stop":
				await host.stop(request.session);
				return finish([`stopped session ${request.session}`]);
			case "approvals": {
				const pending = await host.approvals.pending();
				return finish(pending.length === 0 ? ["nothing waits for approval"] : pending.map((r) => `[${r.conversationId}] ${describeApproval(r)}`));
			}
			case "archive": {
				const record = await host.sessions.archive(request.session, request.archived);
				return finish([request.archived ? `archived session ${record.id}: ${record.title}` : `brought back session ${record.id}: ${record.title}`]);
			}
			case "retitle": {
				let done = 0;
				await host.sessions.retitle((before, after) => {
					if (after === undefined) line(socket, `  ${String(before.id).padStart(4)}  kept: ${before.title}`);
					else {
						done += 1;
						line(socket, `  ${String(before.id).padStart(4)}  ${after.title}   (was: ${before.title})`);
					}
				});
				return finish([done === 0 ? "no titles to write: every session has one from a model or from you" : `wrote ${done} title${done === 1 ? "" : "s"}`]);
			}
			case "live": {
				live ??= createLive(host);
				const client = live.connect((event) => send(socket, { type: "event", event }));
				lives.set(socket, client);
				socket.once("close", () => {
					lives.delete(socket);
					client.close();
				});
				return;
			}
			case "settings":
				send(socket, { type: "settings", settings: request.changes === undefined ? host.settings.get() : host.settings.set(request.changes) });
				return finish([]);
			case "decide": {
				const decided = await host.approvals.decide(request.id, request.allow);
				return decided === undefined ? finish([`no pending approval ${request.id}`], "failed") : finish([describeApproval(decided)]);
			}
		}
	}

	/** The terminal UIs connected, by socket. */
	const lives = new Map<Socket, ReturnType<Live["connect"]>>();
	const server = createServer((socket) => {
		let first = true;
		createInterface({ input: socket }).on("line", (text) => {
			if (!first) {
				// Only a live connection reads past its request: which session to follow.
				try {
					lives.get(socket)?.follow(parseJson(text, followEvent, "the follow").session);
				} catch (error) {
					send(socket, { type: "event", event: { type: "error", message: error instanceof Error ? error.message : String(error) } });
				}
				return;
			}
			first = false;
			handle(socket, text).catch((error) => {
				line(socket, `! ${error instanceof Error ? error.message : String(error)}`);
				send(socket, { type: "done", status: "failed" });
				socket.end();
			});
		});
		socket.on("error", () => {});
	});
	rmSync(socketPath, { force: true });
	server.listen(socketPath, () => chmodSync(socketPath, 0o600));
	return server;
}
