// Small words for times, sizes, paths and tool calls.
import type { Item, SessionState } from "../../src/api-types.ts";

export type Call = Extract<Item, { kind: "call" }>;

/** "now", "6m", "3h", "2d". */
export function age(at: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** "0.4s", "9.1s", "1m 48s". */
export function duration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "41k", "1.2M". */
export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The home directory as ~. */
export const shortPath = (dir: string) => dir.replace(/^\/home\/[^/]+/, "~");

/** A call in a few words: the command's first line, the path, or its arguments. */
export function callLabel(call: Call): string {
	const { command, path } = call.args;
	if (typeof command === "string") return command.split("\n")[0]!;
	if (typeof path === "string") return path;
	return JSON.stringify(call.args).slice(0, 120);
}

/** One line for a finished round of calls: "read 4 files · ran 2 commands · edited 3". */
export function summarize(calls: readonly Call[]): string {
	let read = 0, ran = 0, edited = 0, other = 0;
	for (const call of calls) {
		if (call.tool === "read") read++;
		else if (call.tool === "bash") ran++;
		else if (call.tool === "edit" || call.tool === "write") edited++;
		else other++;
	}
	const parts = [];
	if (read) parts.push(`read ${read} file${read === 1 ? "" : "s"}`);
	if (ran) parts.push(`ran ${ran} command${ran === 1 ? "" : "s"}`);
	if (edited) parts.push(`edited ${edited}`);
	if (other) parts.push(`${other} other call${other === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

export const STATE_LABEL: Record<SessionState | "idea", string> = {
	running: "Running",
	waiting: "Waiting for you",
	failed: "Failed",
	stopped: "Stopped",
	done: "Done",
	idle: "New",
	idea: "Idea",
};

/** How much a project needs Brad: waiting first, then running, then failed. */
export const URGENCY: Record<SessionState, number> = { waiting: 0, running: 1, failed: 2, stopped: 3, done: 4, idle: 5 };
