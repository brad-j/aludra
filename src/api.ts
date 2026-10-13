// The app's API: loopback HTTP for actions, a WebSocket for everything live, and the built app itself. tailscale serve
// puts HTTPS in front and adds Tailscale-User-Login; only the logins in `users` get in (after gaidin's web view).
//
//   GET  /api/bootstrap                   projects, models, thinking levels, defaults
//   POST /api/sessions                    { project, text, model?, thinking? }        → { id }
//   POST /api/sessions/:id/messages       { text, mode: "steer" | "followUp" }
//   POST /api/sessions/:id/stop
//   POST /api/sessions/:id/agent          { model?, thinking? }
//   POST /api/sessions/:id/withdraw       { submission }
//   GET  /api/sessions/:id/changes        what the session changed since it started (src/changes.ts)
//   GET  /api/sessions/:id/changes/diff?path=   one changed file's diff
//   POST /api/approvals/:id               { allow }
//   POST /api/ideas                       { project, text }                            → { id }
//   POST /api/ideas/:id/start                                                          → { id } of the session
//   POST /api/ideas/:id/delete
//   POST /api/projects/color              { project, color: 0-10 | null }                 a picked colour, or the hashed one again
//   GET  /api/push                        the key devices sign up with, and the devices
//   POST /api/push/subscribe              { endpoint, keys: { p256dh, auth }, label }
//   POST /api/push/unsubscribe            { endpoint }
//   POST /api/push/test
//   WS   /api/live                        ServerEvent out, ClientEvent in (src/api-types.ts)
//
// Notifications (src/push.ts) go out when a call waits for approval and when a run ends done or failed, except for a
// session the app is showing on screen.
//   GET  anything else                    the app: a built file, or the app's shell
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { extname, join, normalize } from "node:path";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocketServer, type WebSocket } from "ws";
import { createAmyrlinEndpoint } from "./amyrlin/endpoint.ts";
import type { Bootstrap, ClientEvent, Item, PushState, ServerEvent, SessionMeta, SessionSummary, Thinking } from "./api-types.ts";
import { PACKAGE_DIR, THINKING } from "./config.ts";
import { context, type Host, type SessionRecord } from "./host.ts";
import { boolean, integer, literal, nullable, object, optional, ParseError, parseJson, string } from "./parse.ts";
import { findProject } from "./projects.ts";
import type { ApprovalRequest } from "./permissions.ts";
import type { Push, PushMessage } from "./push.ts";
import { contextUsed, firstChange, itemsOf, lineOf, queuedOf, stateOf, updatedAt } from "./transcript.ts";
import { changesSince, fileDiff } from "./changes.ts";

/** Where `pnpm build` puts the app. */
export const APP_DIR = join(PACKAGE_DIR, "dist", "client");
const SHELL = "_shell.html";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * On every response. Another site can't frame the app, which would carry the user's tailnet identity, and the app runs only
 * its own scripts: the shell's inline scripts are allowed by hash, so nothing a model writes can run.
 */
function securityHeaders(scriptHashes: readonly string[]) {
	const scripts = ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)].join(" ");
	return {
		"Content-Security-Policy":
			`default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; ` +
			"worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		"X-Frame-Options": "DENY",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	};
}

/**
 * The sha256 of each inline script in `html`, for the CSP. Browsers hash the script as parsed, which turns NUL into
 * U+FFFD (TanStack's shell has one) and CRLF into LF.
 */
export function inlineScriptHashes(html: string): string[] {
	return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => {
		const parsed = m[1]!.replace(/\r\n?/g, "\n").replaceAll("\u0000", "\uFFFD");
		return createHash("sha256").update(parsed).digest("base64");
	});
}

/**
 * Another site open in the user's browser could post here with their tailnet identity. A JSON body forces a CORS preflight,
 * which gets no CORS headers back, and the Origin has to be this host.
 */
function sameOrigin(request: IncomingMessage, json: boolean): boolean {
	if (json && !request.headers["content-type"]?.startsWith("application/json")) return false;
	const origin = request.headers.origin;
	return origin === undefined || origin === `https://${request.headers.host}` || origin === `http://${request.headers.host}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > 200_000) throw new HttpError(413, "Too large");
	}
	return text;
}

const thinking = literal<Thinking>(...THINKING);
const newSession = object({ project: string, text: string, model: optional(string), thinking: optional(thinking), requestId: optional(string) });
const message = object({ text: string, mode: literal("steer", "followUp"), requestId: optional(string) });
const agentChange = object({ model: optional(string), thinking: optional(thinking) });
const withdrawal = object({ submission: integer });
const decision = object({ allow: boolean });
const clientEvent = object({ type: literal("follow", "visible"), session: optional(integer), visible: optional(boolean) });
const newIdea = object({ project: string, text: string });
const projectColor = object({ project: string, color: nullable(integer) });
const subscription = object({ endpoint: string, keys: object({ p256dh: string, auth: string }), label: optional(string) });
const endpointBody = object({ endpoint: string });

export type ApiOptions = {
	/** The Tailscale logins let in. */
	users: readonly string[];
	/** Where the built app is; without one, only the API is served. */
	appDir?: string;
	/** Notifications to devices; without it, none are sent. */
	push?: Push;
	/** The host's name in the amyrlin Mac app. Default: this machine's name. */
	name?: string;
};

export function createApi(host: Host, options: ApiOptions) {
	const appDir = options.appDir ?? APP_DIR;
	const shellPath = join(appDir, SHELL);
	const shell = existsSync(shellPath) ? readFileSync(shellPath, "utf8") : undefined;
	const headers = securityHeaders(shell === undefined ? [] : inlineScriptHashes(shell));
	const { push } = options;
	/** What each open socket follows, and whether its app is on screen. */
	const watchers = new Map<WebSocket, { session: number | null; visible: boolean }>();
	const onScreen = (id: number) => [...watchers.values()].some((w) => w.session === id && w.visible);

	function notify(id: number, message: PushMessage) {
		if (push === undefined || onScreen(id)) return;
		push.send(message).catch((error) => console.error("[push]", error instanceof Error ? error.message : error));
	}

	const feed = sessionsFeed(host, (after) => {
		const url = `/s/${after.id}`;
		if (after.state === "done") notify(after.id, { title: `Done · ${after.project}`, body: `${after.title}\n${after.line}`, tag: `session-${after.id}`, url });
		if (after.state === "failed") notify(after.id, { title: `Failed · ${after.project}`, body: `${after.title}\n${after.line}`, tag: `session-${after.id}`, url, urgency: "high" });
	});
	// An approval is pushed after a moment, if it still waits: the app may be about to show it, or the user may answer it at once.
	const APPROVAL_DELAY_MS = 2000;
	const timers = new Set<NodeJS.Timeout>();
	const TEST_DELAY_MS = 5000;
	const stopApprovals = host.approvals.onChange((request: ApprovalRequest) => {
		if (request.status !== "pending") return;
		const timer = setTimeout(() => void pushApproval(request).catch((error) => console.error("[push]", error)).finally(() => timers.delete(timer)), APPROVAL_DELAY_MS);
		timers.add(timer);
	});
	async function pushApproval(request: ApprovalRequest) {
		if (!(await host.approvals.pending()).some((r) => r.id === request.id)) return;
		const session = await host.sessions.get(request.conversationId);
		notify(request.conversationId, {
			title: `Waiting for you · ${session?.project ?? "aludra"}`,
			body: `Wants to run ${request.summary}: ${request.command}\n${session?.title ?? ""}`,
			tag: `approval-${request.id}`,
			url: `/s/${request.conversationId}`,
			urgency: "high",
		});
	}

	feed.start();
	const ideasEvent = async (): Promise<ServerEvent> => ({ type: "ideas", ideas: await host.ideas.list() });

	function reply(response: ServerResponse, status: number, body: string | Buffer, type: string, cache = "no-store") {
		response.writeHead(status, { ...headers, "Content-Type": type, "Cache-Control": cache });
		response.end(body);
	}
	const json = (response: ServerResponse, value: unknown) => reply(response, 200, JSON.stringify(value), "application/json");

	function bootstrap(login: string): Bootstrap {
		const choices = host.choices();
		const model = choices.find((c) => c.id === host.model.modelId) ?? { provider: host.model.provider, id: host.model.modelId, name: host.model.modelId };
		return {
			user: login,
			machine: hostname(),
			projects: host.projects().map(({ workspace, name, path, dir }) => ({ workspace, name, path, dir })),
			models: choices,
			thinking: [...THINKING],
			defaults: { model, thinking: host.thinking },
		};
	}

	async function pushState(): Promise<PushState> {
		if (push === undefined) throw new HttpError(404, "Notifications are off");
		return { publicKey: push.publicKey, devices: (await push.devices()).map(({ endpoint, label, addedAt }) => ({ endpoint, label, addedAt })) };
	}

	async function post(path: string, body: string, origin: string): Promise<unknown> {
		if (path === "/api/projects/color") {
			const request = parseJson(body, projectColor, "the colour");
			return { colors: await host.colors.set(request.project, request.color ?? null) };
		}
		if (path === "/api/ideas") {
			const request = parseJson(body, newIdea, "the idea");
			if (request.text.trim() === "") throw new HttpError(400, "Say what the idea is");
			return { id: (await host.ideas.add(findProject(host.projects(), request.project), request.text)).id };
		}
		const idea = /^\/api\/ideas\/(\d+)\/(start|delete)$/.exec(path);
		if (idea !== null) {
			const id = Number(idea[1]);
			if (idea[2] === "start") return { id: (await host.ideas.start(id)).id };
			if ((await host.ideas.remove(id)) === undefined) throw new HttpError(404, `No idea ${id}`);
			return {};
		}
		if (path.startsWith("/api/push/")) {
			if (push === undefined) throw new HttpError(404, "Notifications are off");
			if (path === "/api/push/subscribe") {
				const request = parseJson(body, subscription, "the subscription");
				try {
					await push.add({ endpoint: request.endpoint, p256dh: request.keys.p256dh, auth: request.keys.auth, label: request.label ?? "a device", origin });
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
				return pushState();
			}
			if (path === "/api/push/unsubscribe") {
				await push.remove(parseJson(body, endpointBody, "the device").endpoint);
				return pushState();
			}
			if (path === "/api/push/test") {
				// After a moment, so the phone can be locked first: iOS shows no banner for the web app on screen.
				const timer = setTimeout(() => {
					timers.delete(timer);
					push.send({ title: "aludra", body: "Notifications work on this device.", tag: "test" }).catch((error) => console.error("[push]", error instanceof Error ? error.message : error));
				}, TEST_DELAY_MS);
				timers.add(timer);
				return { devices: (await push.devices()).length, inSeconds: TEST_DELAY_MS / 1000 };
			}
			throw new HttpError(404, "Not found");
		}
		if (path === "/api/sessions") {
			const request = parseJson(body, newSession, "the new session");
			if (request.text.trim() === "") throw new HttpError(400, "Say what the session should do");
			const agent = { ...(request.model === undefined ? {} : { model: request.model }), ...(request.thinking === undefined ? {} : { thinking: request.thinking }) };
			// An empty project is a no-project session, in a scratch directory of its own.
			const session = request.project === "" ? await host.sessions.createScratch(request.text, agent) : await host.sessions.create(findProject(host.projects(), request.project), request.text, agent);
			await host.submit(session.id, request.text, request.requestId === undefined ? {} : { requestId: request.requestId });
			return { id: session.id };
		}
		const approval = /^\/api\/approvals\/([\w-]+)$/.exec(path);
		if (approval !== null) {
			const decided = await host.approvals.decide(approval[1]!, parseJson(body, decision, "the decision").allow);
			if (decided === undefined) throw new HttpError(409, "That approval isn't waiting any more");
			return { status: decided.status };
		}
		const match = /^\/api\/sessions\/(\d+)\/(messages|stop|agent|withdraw)$/.exec(path);
		if (match === null) throw new HttpError(404, "Not found");
		const id = Number(match[1]);
		if ((await host.sessions.get(id)) === undefined) throw new HttpError(404, `No session ${id}`);
		switch (match[2]) {
			case "messages": {
				const request = parseJson(body, message, "the message");
				if (request.text.trim() === "") throw new HttpError(400, "The message is empty");
				const submission = await host.submit(id, request.text, { steer: request.mode === "steer", ...(request.requestId === undefined ? {} : { requestId: request.requestId }) });
				return { submission: Number(submission.id) };
			}
			case "stop":
				await host.stop(id);
				return {};
			case "agent":
				await host.configure(id, parseJson(body, agentChange, "the change"));
				feed.touch(id);
				return {};
			default:
				return { result: await host.withdraw(id, parseJson(body, withdrawal, "the withdrawal").submission) };
		}
	}

	/** A file of the built app, or the shell for any other page. */
	function serveApp(path: string, response: ServerResponse) {
		const file = normalize(join(appDir, decodeURIComponent(path)));
		if (file.startsWith(appDir) && file !== appDir && existsSync(file) && statSync(file).isFile()) {
			// Vite names built assets by content, so they never change.
			const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
			return reply(response, 200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream", cache);
		}
		if (shell === undefined) throw new HttpError(404, "The app isn't built; run pnpm build");
		return reply(response, 200, shell, TYPES[".html"]!, "no-cache");
	}

	/** Session `id`'s changes, or one file's diff when `file` is given. Only a file in its changes has a diff. */
	async function changes(id: number, file: string | null): Promise<unknown> {
		const record = await host.sessions.get(id);
		if (record === undefined) throw new HttpError(404, `No session ${id}`);
		if (record.base === undefined) {
			const reason = record.baseError === undefined ? "this session started before aludra recorded changes" : record.baseError;
			if (file !== null) throw new HttpError(404, reason);
			return { available: false, reason };
		}
		const summary = await changesSince(record.base);
		if (file === null) return summary;
		if (!summary.available || !summary.files.some((f) => f.path === file)) throw new HttpError(404, `${file} hasn't changed in this session`);
		return { path: file, patch: await fileDiff(record.base, file) };
	}

	/** The Tailscale login of whoever asks, if it's one let in. tailscale serve sets it for a person's device; tagged
	 * devices and anything else get no header. */
	function loginOf(request: IncomingMessage): string | undefined {
		const login = request.headers["tailscale-user-login"];
		return typeof login === "string" && options.users.includes(login) ? login : undefined;
	}

	async function route(request: IncomingMessage, response: ServerResponse, login: string) {
		const url = new URL(request.url ?? "/", "http://host");
		const path = url.pathname;
		if (request.method === "GET" || request.method === "HEAD") {
			if (path === "/api/bootstrap") return json(response, bootstrap(login));
			const changed = /^\/api\/sessions\/(\d+)\/changes(\/diff)?$/.exec(path);
			if (changed !== null) return json(response, await changes(Number(changed[1]), changed[2] === undefined ? null : url.searchParams.get("path") ?? ""));
			if (path === "/api/push") return json(response, await pushState());
			if (path.startsWith("/api/")) throw new HttpError(404, "Not found");
			return serveApp(path, response);
		}
		if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
		// The app's address, which push services are given as aludra's contact: tailscale serve sets the host and is HTTPS.
		const origin = `https://${request.headers["x-forwarded-host"] ?? request.headers.host}`;
		return json(response, await post(path, await readBody(request), origin));
	}

	const server = createServer((request, response) => {
		const login = loginOf(request);
		if (login === undefined) return reply(response, 403, "Forbidden", "text/plain");
		if (request.method === "POST" && !sameOrigin(request, true)) return reply(response, 403, "Cross-site request", "text/plain");
		route(request, response, login).catch((error) => {
			const status = error instanceof HttpError ? error.status : error instanceof ParseError ? 400 : /^no (session|project|model|idea)|could be/.test(String(error?.message)) ? 404 : 500;
			if (status === 500) console.error("[api]", error);
			if (!response.headersSent) reply(response, status, error instanceof Error ? error.message : String(error), "text/plain");
			else response.end();
		});
	});

	const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	// The amyrlin Mac app (src/amyrlin/endpoint.ts). A native app sends no Origin, and a browser always does, so a web
	// page can't open this socket with the user's Tailscale identity.
	const amyrlin = createAmyrlinEndpoint(host, { name: options.name ?? hostname().split(".")[0]! });
	const amyrlinSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	server.on("upgrade", (request, socket, head) => {
		const path = new URL(request.url ?? "/", "http://host").pathname;
		if (path === "/amyrlin") {
			const login = loginOf(request);
			if (login === undefined || request.headers.origin !== undefined) {
				socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
				return;
			}
			const name = request.headers["tailscale-user-name"];
			amyrlinSockets.handleUpgrade(request, socket, head, (ws) => amyrlin.connect(ws, { login, name: typeof name === "string" ? name : login }));
			return;
		}
		if (path !== "/api/live" || loginOf(request) === undefined || !sameOrigin(request, false)) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(request, socket, head, (ws) => live(ws));
	});

	function live(ws: WebSocket) {
		const send = (event: ServerEvent) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
		};
		const stopFeed = feed.subscribe((sessions) => send({ type: "sessions", sessions }));
		const sendIdeas = () => void ideasEvent().then(send, (error) => console.error("[api]", error));
		const stopIdeas = host.ideas.onChange(sendIdeas);
		sendIdeas();
		const stopColors = host.colors.onChange((colors) => send({ type: "colors", colors }));
		void host.colors.list().then((colors) => send({ type: "colors", colors }), (error) => console.error("[api]", error));
		const watcher = { session: null as number | null, visible: true };
		watchers.set(ws, watcher);
		let following: (() => void) | undefined;
		// Proxies drop a WebSocket that says nothing for a while.
		const ping = setInterval(() => ws.ping(), 25_000);
		ws.on("message", (data) => {
			let event: ClientEvent;
			try {
				const parsed = parseJson(String(data), clientEvent, "the event");
				event = parsed.type === "visible" ? { type: "visible", visible: parsed.visible ?? true } : { type: "follow", session: parsed.session ?? null };
			} catch (error) {
				send({ type: "error", message: error instanceof Error ? error.message : String(error) });
				return;
			}
			if (event.type === "visible") {
				watcher.visible = event.visible;
				return;
			}
			watcher.session = event.session;
			following?.();
			following = undefined;
			if (event.session !== null) {
				follow(event.session, send, feed).then((stop) => (following = stop), (error) => send({ type: "error", message: String(error?.message ?? error) }));
			}
		});
		ws.on("close", () => {
			clearInterval(ping);
			watchers.delete(ws);
			stopIdeas();
			stopColors();
			stopFeed();
			following?.();
		});
		ws.on("error", () => {});
	}

	/** Sends `send` session `id`'s transcript and meta, then each change, until the returned function is called. */
	async function follow(id: number, send: (event: ServerEvent) => void, feed: SessionsFeed): Promise<() => void> {
		const record = await host.sessions.get(id);
		if (record === undefined) throw new Error(`No session ${id}`);
		const state = await (await host.conversation(id)).viewState(context);
		let sent: string[] = [];
		let sentMeta = "";
		let stopped = false;
		let pending: ConversationView | undefined;
		let timer: NodeJS.Timeout | undefined;

		async function publish(view: ConversationView) {
			const items = itemsOf(view);
			const keys = items.map((item) => JSON.stringify(item));
			const start = firstChange(sent, keys);
			if (start < keys.length || keys.length !== sent.length) send({ type: "items", session: id, start, items: items.slice(start), length: items.length });
			sent = keys;
			const meta = await metaOf(record!, view, items);
			if (stopped) return;
			const metaJson = JSON.stringify(meta);
			if (metaJson !== sentMeta) send({ type: "meta", session: id, meta });
			sentMeta = metaJson;
			feed.update(meta.summary);
		}
		// Commits come every 100 ms while an answer streams; send at most every 50 ms.
		const schedule = (view: ConversationView) => {
			pending = view;
			timer ??= setTimeout(() => {
				timer = undefined;
				const next = pending!;
				pending = undefined;
				if (!stopped) publish(next).catch((error) => console.error("[api]", error));
			}, 50);
		};
		await publish(state.value);
		const unsubscribe = state.subscribe((view) => schedule(view));
		const unwatchApprovals = host.approvals.onChange((request) => {
			if (request.conversationId === id) schedule(state.value);
		});
		return () => {
			stopped = true;
			clearTimeout(timer);
			unsubscribe();
			unwatchApprovals();
			state.dispose();
		};
	}

	async function metaOf(record: SessionRecord, view: ConversationView, items: readonly Item[]): Promise<SessionMeta> {
		const approval = (await host.approvals.all()).find((r) => r.conversationId === record.id && r.status === "pending");
		// SAFETY: a document in the view is the JSON of its kind's state.
		const agent = view.docs["pi.agent"] as { model?: { provider: string; modelId: string }; thinkingLevel?: Thinking } | undefined;
		const ref = agent?.model ?? host.model;
		const info = host.modelInfo(ref);
		// SAFETY: as above.
		const retry = (view.docs["pi.live"] as { generation?: { retry?: { at: number; error: string } } } | undefined)?.generation?.retry;
		return {
			summary: summaryOf(record, view, items, approval !== undefined),
			model: { provider: ref.provider, id: ref.modelId, name: info.name },
			thinking: agent?.thinkingLevel ?? host.thinking,
			context: { used: contextUsed(view), window: info.window },
			queued: queuedOf(view),
			...(approval === undefined ? {} : { approval: { id: approval.id, summary: approval.summary, command: approval.command } }),
			...(retry === undefined ? {} : { retry }),
		};
	}

	return {
		server,
		listen: (port: number, done?: () => void) => server.listen(port, "127.0.0.1", done),
		close: async () => {
			feed.close();
			stopApprovals();
			for (const timer of timers) clearTimeout(timer);
			for (const ws of sockets.clients) ws.terminate();
			sockets.close();
			amyrlin.close();
			for (const ws of amyrlinSockets.clients) ws.terminate();
			amyrlinSockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function summaryOf(record: SessionRecord, view: ConversationView, items: readonly Item[], waiting: boolean): SessionSummary {
	const state = stateOf(view, waiting);
	const { id, workspace, project, dir, title, createdAt } = record;
	return { id, workspace, project, dir, title, createdAt, updatedAt: updatedAt(view, record.createdAt), state, line: lineOf(items, state) };
}

type SessionsFeed = ReturnType<typeof sessionsFeed>;

/**
 * Every session's summary, kept current: a session is read again when a task of it starts or ends, when one of its
 * approvals changes, and when it's created. A session someone follows is updated from its view as it changes.
 */
function sessionsFeed(host: Host, onRunEnd: (summary: SessionSummary) => void) {
	const summaries = new Map<number, SessionSummary>();
	const put = (summary: SessionSummary) => {
		const before = summaries.get(summary.id);
		summaries.set(summary.id, summary);
		return before;
	};
	/** Sessions whose run's tasks just ended; read again, a run that ended done or failed is reported once. */
	const ended = new Set<number>();
	/** The last run reported per session, by its newest timestamp, so a run is reported once. */
	const reported = new Map<number, number>();
	const listeners = new Set<(sessions: SessionSummary[]) => void>();
	let live = new Set<number>();
	let ready: Promise<void> | undefined;
	let graphStop: (() => Promise<unknown>) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const dirty = new Set<number>();
	const unsubscribe: (() => unknown)[] = [];
	let closed = false;

	const list = () => [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const broadcast = () => {
		const sessions = list();
		for (const listener of listeners) listener(sessions);
	};

	async function read(id: number): Promise<SessionSummary | undefined> {
		const record = await host.sessions.get(id);
		if (record === undefined) return undefined;
		const state = await (await host.conversation(id)).viewState(context);
		try {
			const waiting = (await host.approvals.all()).some((r) => r.conversationId === id && r.status === "pending");
			return summaryOf(record, state.value, itemsOf(state.value), waiting);
		} finally {
			state.dispose();
		}
	}

	async function flush() {
		timer = undefined;
		const ids = [...dirty];
		dirty.clear();
		for (const id of ids) {
			const summary = await read(id);
			if (summary === undefined) continue;
			put(summary);
			if (!ended.delete(id) || (summary.state !== "done" && summary.state !== "failed")) continue;
			if (reported.get(id) === summary.updatedAt) continue;
			reported.set(id, summary.updatedAt);
			onRunEnd(summary);
		}
		if (!closed && ids.length > 0) broadcast();
	}

	function mark(ids: Iterable<number>) {
		for (const id of ids) dirty.add(id);
		timer ??= setTimeout(() => void flush().catch((error) => console.error("[api]", error)), 150);
	}

	async function start() {
		for (const record of await host.sessions.list()) {
			const summary = await read(record.id);
			if (summary !== undefined) summaries.set(record.id, summary);
		}
		const graph = await host.harness.watchTaskGraph(context);
		graphStop = () => graph.stop();
		// A session works while it has a generation or tool task; a background compaction isn't a run.
		const working = (value: typeof graph.value) =>
			new Set(Object.values(value.tasks).filter((task) => task.kind === "pi.generation" || task.kind === "pi.tool").map((task) => Number(task.conversationId)));
		const onGraph = (value: typeof graph.value) => {
			const now = working(value);
			for (const id of live) if (!now.has(id)) ended.add(id);
			// Sessions working now, and those that just stopped.
			mark(new Set([...now, ...live, ...Object.values(value.tasks).map((task) => Number(task.conversationId))]));
			live = now;
		};
		live = working(graph.value);
		graph.start(async (value) => onGraph(value));
		unsubscribe.push(host.approvals.onChange((request) => mark([request.conversationId])), host.sessions.onCreate((record) => mark([record.id])));
	}

	return {
		/** Starts watching the sessions, for notifications, before anyone subscribes. */
		start() {
			ready ??= start();
			ready.catch((error) => console.error("[api]", error));
		},
		/** Calls `listener` with every session now and after each change. */
		subscribe(listener: (sessions: SessionSummary[]) => void): () => void {
			listeners.add(listener);
			ready ??= start();
			ready.then(() => listeners.has(listener) && listener(list()), (error) => console.error("[api]", error));
			return () => listeners.delete(listener);
		},
		/** A followed session's new summary, from its view. */
		update(summary: SessionSummary) {
			const before = put(summary);
			if (JSON.stringify(before) !== JSON.stringify(summary)) broadcast();
		},
		/** Reads session `id` again. */
		touch(id: number) {
			mark([id]);
		},
		close() {
			closed = true;
			clearTimeout(timer);
			for (const stop of unsubscribe) stop();
			void graphStop?.();
		},
	};
}

