// The app's view of the host: the sessions list and the followed session, kept current over one WebSocket
// (src/api.ts), plus the bootstrap and the actions, which are plain POSTs. Components read it with useLive().
import { useSyncExternalStore } from "react";
import type { Bootstrap, Idea, Item, ServerEvent, SessionMeta, SessionSummary, Thinking } from "../../src/api-types.ts";
import type { Attached } from "./images.ts";

export type Connection = "connecting" | "open" | "closed";

export type LiveState = {
	connection: Connection;
	bootstrap?: Bootstrap;
	sessions?: SessionSummary[];
	ideas: Idea[];
	/** Projects whose colour was picked: name to hue index. */
	colors: Record<string, number>;
	/** The session followed, and what's arrived of it. */
	followed: number | null;
	items: Item[];
	meta?: SessionMeta;
	/** The last thing that went wrong, shown until the next action. */
	error?: string;
};

let state: LiveState = { connection: "connecting", followed: null, items: [], ideas: [], colors: {} };
const listeners = new Set<() => void>();

function set(change: Partial<LiveState>) {
	state = { ...state, ...change };
	for (const listener of listeners) listener();
}

export function useLive<T>(select: (state: LiveState) => T): T {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			start();
			return () => listeners.delete(listener);
		},
		() => select(state),
		() => select(state),
	);
}

let socket: WebSocket | undefined;
let started = false;
let retry = 0;

function start() {
	if (started || typeof window === "undefined") return;
	started = true;
	void loadBootstrap();
	connect();
	// Back from the background (a phone's lock screen): the socket may be gone without saying so. The host is told
	// whether the app is on screen, so it doesn't notify about the session you're looking at.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) connect();
		else sendVisible();
	});
}

async function loadBootstrap() {
	try {
		const response = await fetch("/api/bootstrap");
		if (!response.ok) throw new Error(await response.text());
		set({ bootstrap: await response.json() });
	} catch (error) {
		set({ error: `Can't load the app's settings: ${error instanceof Error ? error.message : String(error)}` });
		setTimeout(loadBootstrap, 3000);
	}
}

function connect() {
	socket?.close();
	const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
	socket = ws;
	set({ connection: "connecting" });
	ws.onopen = () => {
		retry = 0;
		set({ connection: "open" });
		sendVisible();
		if (state.followed !== null) ws.send(JSON.stringify({ type: "follow", session: state.followed }));
	};
	ws.onmessage = (message) => receive(JSON.parse(String(message.data)) as ServerEvent);
	ws.onclose = () => {
		if (socket !== ws) return;
		set({ connection: "closed" });
		retry = Math.min(retry + 1, 6);
		setTimeout(connect, 500 * 2 ** retry);
	};
}

function receive(event: ServerEvent) {
	switch (event.type) {
		case "sessions":
			return set({ sessions: event.sessions });
		case "ideas":
			return set({ ideas: event.ideas });
		case "colors":
			return set({ colors: event.colors });
		case "items":
			if (event.session !== state.followed) return;
			return set({ items: [...state.items.slice(0, event.start), ...event.items].slice(0, event.length) });
		case "meta":
			if (event.session !== state.followed) return;
			return set({ meta: event.meta });
		case "error":
			return set({ error: event.message });
	}
}

function sendVisible() {
	if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "visible", visible: document.visibilityState === "visible" }));
}

/** Follows session `id`'s transcript, or none. */
export function follow(id: number | null) {
	if (state.followed === id) return;
	set({ followed: id, items: [], meta: undefined });
	if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "follow", session: id }));
}

/** Shows `message` above the composer until the next action. */
export function setError(message: string) {
	set({ error: message });
}

export function clearError() {
	if (state.error !== undefined) set({ error: undefined });
}

export async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) {
		const message = (await response.text()) || `The host answered ${response.status}`;
		set({ error: message });
		throw new Error(message);
	}
	clearError();
	return response.json();
}

const requestId = () => crypto.randomUUID();

export const actions = {
	start: (project: string, text: string, model: string, thinking: Thinking, images: readonly Attached[] = []) =>
		post<{ id: number }>("/api/sessions", { project, text, images: images.map(({ mimeType, data }) => ({ mimeType, data })), model, thinking, requestId: requestId() }),
	send: (session: number, text: string, mode: "steer" | "followUp", images: readonly Attached[] = []) =>
		post(`/api/sessions/${session}/messages`, { text, images: images.map(({ mimeType, data }) => ({ mimeType, data })), mode, requestId: requestId() }),
	stop: (session: number) => post(`/api/sessions/${session}/stop`, {}),
	rename: (session: number, title: string) => post<{ title: string }>(`/api/sessions/${session}/title`, { title }),
	configure: (session: number, change: { model?: string; thinking?: Thinking }) => post(`/api/sessions/${session}/agent`, change),
	withdraw: (session: number, submission: number) => post(`/api/sessions/${session}/withdraw`, { submission }),
	decide: (approval: string, allow: boolean) => post(`/api/approvals/${approval}`, { allow }),
	saveIdea: (project: string, text: string) => post<{ id: number }>("/api/ideas", { project, text }),
	startIdea: (idea: number) => post<{ id: number }>(`/api/ideas/${idea}/start`, {}),
	deleteIdea: (idea: number) => post(`/api/ideas/${idea}/delete`, {}),
};
