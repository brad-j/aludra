// Every model a session can run on: each loaded provider's that this machine is signed in to. Claude Code's are the ones
// the Claude account offers, OpenAI's on a ChatGPT sign-in the ones that account offers, and OpenRouter's its whole
// catalog, priced.
// `model.choices` in the settings are the pinned ones the pickers show first; any model here can be picked too.
import type { Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelChoice } from "./api-types.ts";
import { accountModels } from "./login.ts";
import { BILLED } from "./transcript.ts";

/** "Claude Opus 5.5 1M" as "Opus 5.5". */
export const displayName = (name: string) => name.replace(/^Claude /, "").replace(/ (1M|\(latest\))$/, "");

/** A model as the pickers list it, with its price per million tokens where requests are billed. */
export function choiceOf(provider: string, model: Model<never> | Model<string>): ModelChoice {
	const choice: ModelChoice = { provider, id: model.id, name: displayName(model.name) };
	if (BILLED.has(provider)) choice.price = { input: model.cost.input, output: model.cost.output };
	return choice;
}

/** How long the ChatGPT account's model list is kept before it's asked for again. */
const ACCOUNT_TTL_MS = 3_600_000;

export function createCatalog(models: Models) {
	let account: { at: number; ids: Set<string> } | undefined;

	async function openaiIds(): Promise<Set<string> | undefined> {
		if (account !== undefined && Date.now() - account.at < ACCOUNT_TTL_MS) return account.ids;
		try {
			const { runnable } = await accountModels(models);
			account = { at: Date.now(), ids: new Set(runnable.map((m) => m.id)) };
			return account.ids;
		} catch (error) {
			console.error(`[models] couldn't list the ChatGPT account's models: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/** Every model a session can run on now, by provider. A provider not signed in has none. */
	async function list(): Promise<ModelChoice[]> {
		const all: ModelChoice[] = [];
		for (const provider of models.getProviders()) {
			const auth = await models.checkAuth(provider.id).catch(() => undefined);
			if (auth === undefined) continue;
			let chat = models.getModels(provider.id);
			// A ChatGPT sign-in runs only what the account offers; an API key runs anything.
			if (provider.id === "openai" && auth.type === "oauth") {
				const ids = await openaiIds();
				if (ids !== undefined) chat = chat.filter((m) => ids.has(m.id));
			}
			all.push(...chat.map((m) => choiceOf(provider.id, m)));
		}
		return all;
	}

	return { list, forget: () => (account = undefined) };
}

export type Catalog = ReturnType<typeof createCatalog>;
