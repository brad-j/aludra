// Checkpoints: the project's files as each turn starts, so a session's changes can be read a turn at a time and put
// back to how they were before any turn.
//
// A checkpoint is a snapshot like a session's starting point (src/changes.ts), taken the first time a request answers a
// new user message: the hook sees the request's messages end with a user message it hasn't checkpointed, keyed by that
// message's timestamp. A steer or a queued follow-up is checkpointed when it reaches the model, not when it was sent, so
// each turn's changes start where the previous turn's tools stopped. A turn's changes run from its checkpoint to the
// next one, or to now for the latest. They include any edit made by hand between turns.
//
// Restoring writes a checkpoint's files back over the project. It is refused while the session runs or waits, and it
// first snapshots the files as they are, as a checkpoint of its own, so a restore is undone by restoring that one. The
// session's next message tells the agent which files were put back, since what it read earlier may no longer hold.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, GenerationTask, type Harness, hook } from "@earendil-works/pi-durable";
import type { Changes } from "./api-types.ts";
import { changesBetween, fileDiffBetween, restoreTree, type Snapshot, snapshot } from "./changes.ts";

export type Checkpoint = {
	/** 1, 2, 3… within the session. */
	id: number;
	/** When it was taken. */
	at: number;
	tree: string;
	/** "turn": as the user message sent at `message` started a turn. "restore": the files just before a restore. */
	kind: "turn" | "restore";
	/** The timestamp of the user message whose turn starts here; transcript items carry it as `at`. */
	message?: number;
	/** For a "restore", the checkpoint that was put back. */
	restored?: number;
};

/** What a session's next message tells the agent about a restore since its last one. */
export type RestoreNote = { checkpoint: number; message?: number; written: number; deleted: number; files: string[] };

type SessionCheckpoints = { next: number; checkpoints: Checkpoint[]; note?: RestoreNote };

export const Checkpoints = defineDoc<{ sessions: Record<string, SessionCheckpoints> }>({
	kind: "aludra.checkpoints",
	version: 1,
	scope: "session",
	initial: () => ({ sessions: {} }),
});

/** Files named in a restore note, at most. */
const NOTE_FILES = 20;

/** The timestamp of the user message a request answers, if its messages end with one. */
export function answeredMessage(messages: readonly Message[]): number | undefined {
	const last = messages.at(-1);
	return last?.role === "user" ? last.timestamp : undefined;
}

const projectDir = (base: Snapshot) => join(base.top, base.prefix);

export type CheckpointOptions = {
	/** The host's Harness; asked for only once it's open, since the extension is installed before. */
	harness: () => Harness;
	context: Context;
	/** The session's starting point, which says where its project is; undefined for sessions without one. */
	baseOf: (id: number) => Promise<Snapshot | undefined>;
	log?: (message: string) => void;
};

export function createCheckpoints(options: CheckpointOptions) {
	const { context } = options;
	const log = options.log ?? ((m: string) => console.error(`[checkpoints] ${m}`));
	/** Checkpoints being taken, by session and message, so a retried request doesn't take a second. */
	const taking = new Map<string, Promise<void>>();

	async function commit<T>(change: (doc: { sessions: Record<string, SessionCheckpoints> }) => T): Promise<T> {
		const root = await options.harness().root(context);
		return root.commit(async (tx) => change(await tx.doc(Checkpoints)), context);
	}

	async function list(id: number): Promise<Checkpoint[]> {
		const doc = await options.harness().snapshot(Checkpoints, context);
		return (doc?.sessions[String(id)]?.checkpoints ?? []).map((c) => ({ ...c }));
	}

	/** Records `tree` as session `id`'s next checkpoint; returns it. */
	function add(id: number, checkpoint: Omit<Checkpoint, "id">): Promise<Checkpoint> {
		return commit((doc) => {
			// Read back through the draft: changes to the object assigned wouldn't be recorded.
			if (doc.sessions[String(id)] === undefined) doc.sessions[String(id)] = { next: 1, checkpoints: [] };
			const session = doc.sessions[String(id)]!;
			const made = { ...checkpoint, id: session.next };
			session.next += 1;
			session.checkpoints.push(made);
			return { ...made };
		});
	}

	/** Takes session `id`'s checkpoint for the turn of the user message sent at `message`, unless it has one. */
	async function take(id: number, message: number): Promise<void> {
		const key = `${id}:${message}`;
		const running = taking.get(key);
		if (running !== undefined) return running;
		const work = (async () => {
			if ((await list(id)).some((c) => c.kind === "turn" && c.message === message)) return;
			const base = await options.baseOf(id);
			if (base === undefined) return;
			const now = await snapshot(projectDir(base));
			if ("error" in now) return log(`session ${id}: ${now.error}`);
			await add(id, { at: now.at, tree: now.tree, kind: "turn", message });
		})().catch((error) => log(`session ${id}: ${error instanceof Error ? error.message : String(error)}`));
		taking.set(key, work);
		try {
			await work;
		} finally {
			taking.delete(key);
		}
	}

	const extension = defineExtension({
		name: "aludra-checkpoints",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api) => {
					const message = answeredMessage(request.messages);
					if (message !== undefined) await take(Number(api.conversationId), message);
					return undefined;
				},
			}),
		],
	});

	/** Where a turn's changes end: the next checkpoint's tree, or undefined for now. */
	function endOf(checkpoints: readonly Checkpoint[], id: number): string | undefined {
		const index = checkpoints.findIndex((c) => c.id === id);
		return checkpoints[index + 1]?.tree;
	}

	/** What changed from checkpoint `checkpoint` to the next, or to now for the latest. */
	async function changes(id: number, checkpoint: number): Promise<Changes> {
		const base = await options.baseOf(id);
		if (base === undefined) return { available: false, reason: "this session has no checkpoints" };
		const all = await list(id);
		const found = all.find((c) => c.id === checkpoint);
		if (found === undefined) throw new Error(`no checkpoint ${checkpoint} in session ${id}`);
		let to = endOf(all, checkpoint);
		if (to === undefined) {
			const now = await snapshot(projectDir(base));
			if ("error" in now) return { available: false, reason: now.error };
			to = now.tree;
		}
		return changesBetween(base, found.tree, to, found.at);
	}

	/** One file's diff over checkpoint `checkpoint`'s turn; only a file in its changes has one. */
	async function diff(id: number, checkpoint: number, path: string): Promise<string> {
		const summary = await changes(id, checkpoint);
		if (!summary.available || !summary.files.some((f) => f.path === path)) throw new Error(`no file ${path} changed in checkpoint ${checkpoint}`);
		const base = (await options.baseOf(id))!;
		const all = await list(id);
		const from = all.find((c) => c.id === checkpoint)!.tree;
		let to = endOf(all, checkpoint);
		if (to === undefined) {
			const now = await snapshot(projectDir(base));
			if ("error" in now) throw new Error(now.error);
			to = now.tree;
		}
		return fileDiffBetween(base, from, to, path);
	}

	/**
	 * Puts session `id`'s project back to checkpoint `checkpoint`, after recording the files as they are; `busy` says
	 * whether the session runs or waits, which refuses it.
	 */
	async function restore(id: number, checkpoint: number, busy: boolean) {
		if (busy) throw new RestoreRefused("the session is running; stop it or wait before restoring");
		const base = await options.baseOf(id);
		if (base === undefined) throw new RestoreRefused("this session has no checkpoints");
		const found = (await list(id)).find((c) => c.id === checkpoint);
		if (found === undefined) throw new Error(`no checkpoint ${checkpoint} in session ${id}`);
		const now = await snapshot(projectDir(base));
		if ("error" in now) throw new RestoreRefused(now.error);
		const before = await changesBetween(base, found.tree, now.tree, found.at);
		const files = before.available ? before.files.map((f) => f.path) : [];
		const undo = await add(id, { at: now.at, tree: now.tree, kind: "restore", restored: checkpoint });
		const result = await restoreTree(base, found.tree);
		await commit((doc) => {
			const session = doc.sessions[String(id)]!;
			session.note = { checkpoint, ...(found.message === undefined ? {} : { message: found.message }), ...result, files: files.slice(0, NOTE_FILES) };
		});
		return { ...result, files, undo: undo.id };
	}

	/** Takes session `id`'s note about a restore, for its next message to carry; undefined when there's none. */
	async function takeNote(id: number): Promise<RestoreNote | undefined> {
		const doc = await options.harness().snapshot(Checkpoints, context);
		if (doc?.sessions[String(id)]?.note === undefined) return undefined;
		return commit((d) => {
			const session = d.sessions[String(id)];
			const note = session?.note;
			if (session !== undefined) delete session.note;
			return note === undefined ? undefined : { ...note, files: [...note.files] };
		});
	}

	return { extension, list, take, changes, diff, restore, takeNote };
}

export type CheckpointService = ReturnType<typeof createCheckpoints>;

/** A restore that can't happen now; the API answers it with 409. */
export class RestoreRefused extends Error {}

/** The text a session's next message carries about a restore, for the agent. */
export function restoreNoteText(note: RestoreNote): string {
	const what = `${note.written} written, ${note.deleted} deleted`;
	const shown = note.files.length === 0 ? "" : `: ${note.files.join(", ")}${note.written + note.deleted > note.files.length ? ", …" : ""}`;
	return `<restored checkpoint="${note.checkpoint}">The user put the project's files back to how they were before an earlier turn (${what})${shown}. Read a file again before relying on what you saw of it.</restored>`;
}
