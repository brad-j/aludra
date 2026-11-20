// Subagents: an `agent` tool that hands a self-contained task to a child conversation and returns its final answer,
// so exploring many files or a separate piece of work doesn't fill the session's context.
//
// It's Pi Durable's foreground subagent ("Abort and Subagents" in its README). The child is a conversation owned by the
// tool call: stopping the session aborts the call and with it the child, the session isn't idle until the child is,
// and a rerun after a restart finds the same child and the same submission, so nothing runs twice. The child starts
// as a copy of the session's agent (directory, tools, thinking), then runs on `subagents.model` from the settings, or
// the session's model when that isn't one this host has. It doesn't get this tool or publish_page, so it can't start
// children of its own: one level deep.
//
// A child has no session record. `Subagents` maps it to its session, and the host looks a child's session up through it
// (recordOf in src/host.ts), so a child runs where its session runs (a sandbox, a worktree, a chat's confinement), its
// approvals are its session's, and it gets its session's prompt sections. It's left out of the session lists; the call's
// details carry its conversation ID, and /amyrlin's conversation.watch opens it with `parent` set.
import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, Type, type Usage } from "@earendil-works/pi-ai";
import { type ConversationId, configure, defineDoc, defineExtension, defineTool, type DocumentReader, type Extension, type Harness, type ModelRef, section, UsageDoc } from "@earendil-works/pi-durable";

/** A child: the session it belongs to, the call that started it and the label it was given. */
export type Subagent = { session: number; callId: string; title: string; createdAt: number };

export const Subagents = defineDoc<{ children: Record<string, Subagent> }>({
	kind: "aludra.subagents",
	version: 1,
	scope: "session",
	initial: () => ({ children: {} }),
});

/** What the `agent` call's details carry, for clients: the child, what it runs on, and once it's done, how it ended. */
export type SubagentDetails = { conversationId: number; title: string; model: string; status?: "done" | "unanswered" | "failed" };

export const AGENT_TOOL_DESCRIPTION = [
	"Hand a self-contained task to a subagent and get its final answer back. It's a fresh agent with your tools, working directory and rules, on the model set for subagents, but it has none of this conversation: put everything it needs in the task.",
	"Use it to explore (find where something is defined or used, read many files, survey part of a codebase) or for a separate piece of work, so the detail stays out of your context. Several calls in one turn run at the same time. Don't use it for one quick read or search you can do yourself, or for edits that overlap other work going on. Subagents can't start subagents.",
].join("\n\n");

export const CHILD_SECTION = [
	"You're a subagent. Another agent gave you this task, and your final answer comes back to it as the result of its call, in place of everything you did along the way. The user doesn't watch this conversation as it runs.",
	"Do the task, then answer with what the other agent needs: what you found, with file paths and line numbers, what you changed, and anything you couldn't do or aren't sure of. Skip the plan and result blocks the instructions above describe; they're for replies the user reads.",
].join("\n");

export type SubagentOptions = {
	harness: () => Harness;
	/** The model children run on now, or undefined for the session's own; read at each call, since the settings can change. */
	model: () => ModelRef | undefined;
	/** Extensions a child goes without besides this one, such as publish_page's. */
	without: () => readonly Extension[];
	context: Context;
};

/** The child conversation `id` is, or undefined for a session or anything else. */
export async function subagentOf(read: DocumentReader, id: ConversationId | number, context: Context): Promise<Subagent | undefined> {
	return (await read.snapshot(Subagents, context))?.children[String(id)];
}

/** The text of the last answer in `messages`, and whether it ended in an error. */
function lastAnswer(messages: readonly AssistantMessage[]): { text: string; failed: boolean } | undefined {
	const last = messages.at(-1);
	if (last === undefined) return undefined;
	const text = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
	return { text: text || (last.errorMessage ?? ""), failed: last.stopReason === "error" || last.stopReason === "aborted" };
}

/** Everything a child's answers spent, so its session's ledger counts it under the agent tool. */
function spent(models: Readonly<Record<string, Usage>> | undefined): Usage | undefined {
	const used = Object.values(models ?? {});
	if (used.length === 0) return undefined;
	const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	for (const u of used) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += u[key] ?? 0;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += u.cost?.[key] ?? 0;
	}
	return total;
}

export function subagentsExtension(options: SubagentOptions) {
	const { context } = options;

	/** The child's answers since it started, newest last. */
	async function answers(id: ConversationId): Promise<AssistantMessage[]> {
		const found = await options.harness().conversation(id, context);
		if (found === undefined) return [];
		const page = await found.entries({ order: "descending" }, 50, undefined, context);
		for (const entry of page.items) {
			if (entry.kind !== "pi.assistant") continue;
			// SAFETY: an assistant entry's model messages are the answer's assistant messages.
			return (entry.model ?? []).filter((m) => m.role === "assistant") as AssistantMessage[];
		}
		return [];
	}

	const agent = defineTool({
		name: "agent",
		description: AGENT_TOOL_DESCRIPTION,
		parameters: Type.Object({
			title: Type.String({ description: "A few words naming the task, shown to the user above the subagent's work" }),
			task: Type.String({ description: "The whole task: what to do, where, and what to report back. The subagent sees nothing else of this conversation." }),
		}),
		// A rerun after a restart finds the same child and submission.
		replay: "safe",
		async execute({ title, task }, api, ctx) {
			if ((await subagentOf(api, api.conversationId, ctx)) !== undefined) {
				return { output: [{ type: "text", text: "Subagents can't start subagents. Do this part yourself." }], isError: true };
			}
			if (task.trim() === "") return { output: [{ type: "text", text: "The task is empty." }], isError: true };
			const label = title.trim().slice(0, 120) || "Subagent";
			const parent = await api.agent(ctx);
			const model = options.model() ?? parent.model;
			const self = extension;
			const child = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id;
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, created.id, { ...(model === undefined ? {} : { model }), extensions: { remove: [self, ...options.without()] } });
				(await tx.doc(Subagents)).children[String(created.id)] = { session: Number(api.conversationId), callId: api.callId, title: label, createdAt: Date.now() };
				return created.id;
			}, ctx);
			const named = model === undefined ? "" : `${model.provider}/${model.modelId}`;
			const details: SubagentDetails = { conversationId: Number(child), title: label, model: named };
			await api.details(details, ctx);
			const handle = await api.conversation(child, ctx);
			if (handle === undefined) return { output: [{ type: "text", text: "The subagent's conversation is gone." }], isError: true, details: { ...details, status: "failed" } };
			const submission = await handle.submit({ type: "input", content: task, requestId: `subagent:${api.taskId}` }, ctx);
			const settled = await submission.wait(ctx);
			const answer = lastAnswer(await answers(child));
			// SAFETY: the ledger keeps each answer's Usage as JSON, the same fields.
			const usage = spent((await api.snapshot(UsageDoc, child, ctx))?.models as Record<string, Usage> | undefined);
			const failed = settled.status !== "done" || answer === undefined || answer.failed;
			const text = answer?.text
				? (failed ? `The subagent stopped without finishing: ${answer.text}` : answer.text)
				: "The subagent finished without an answer.";
			return {
				output: [{ type: "text", text }],
				...(failed ? { isError: true } : {}),
				details: { ...details, status: failed ? (settled.status === "done" ? "failed" : "unanswered") : "done" },
				...(usage === undefined ? {} : { usage }),
			};
		},
	});

	const extension: Extension = defineExtension({ name: "aludra-subagents", tools: [agent] });

	/** Told only to children: they answer the agent that called them. Kept apart from the tool, which children go without. */
	const childContext: Extension = defineExtension({
		name: "aludra-subagent-context",
		sections: [section("subagent", async ({ conversationId, read }) => ((await subagentOf(read, conversationId, context)) === undefined ? undefined : CHILD_SECTION))],
	});

	return { extension, childContext };
}
