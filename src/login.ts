// `aludra login` and `aludra logout`: signing in to a model provider besides Claude Code, which keeps its own login
// (claude auth login). OpenAI's is Sign in with ChatGPT, OpenAI's flow for open-source apps on the user's own machine:
// requests go to api.openai.com on the user's ChatGPT plan, not an API key. Its callback comes to 127.0.0.1:1455 on this
// machine, so with the browser elsewhere, the address the browser ends on is pasted here instead.
import { createInterface } from "node:readline/promises";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Config } from "./config.ts";
import { credentialsFile, deviceId, fileCredentialStore } from "./credentials.ts";

/** The providers `aludra login` signs in to. */
export const SIGN_INS = ["openai"] as const;

/** OpenAI on this machine's sign-ins, for logging in and checking; the host builds its own with the bridge beside it. */
export function signInModels(config: Config): Models {
	const models = createModels({ credentials: fileCredentialStore(credentialsFile(config.dataDir)) });
	models.setProvider(openaiProvider());
	return models;
}

/** Asks on the terminal. A prompt the flow cancels (the browser's callback came first) stops asking. */
async function ask(message: string, signal?: AbortSignal): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// Readline would only pause on Ctrl+C, leaving the login waiting.
	rl.on("SIGINT", () => process.exit(130));
	try {
		return (await rl.question(`${message}\n> `, signal === undefined ? {} : { signal })).trim();
	} finally {
		rl.close();
	}
}

const terminal: AuthInteraction = {
	notify(event) {
		if (event.type === "auth_url") console.log(`\nOpen this in a browser and sign in:\n\n  ${event.url}\n${event.instructions === undefined ? "" : `\n${event.instructions}`}`);
		else if (event.type === "device_code") console.log(`\nAt ${event.verificationUri}, enter ${event.userCode}`);
		else console.log(event.message);
	},
	async prompt(prompt) {
		if (prompt.type !== "select") return ask(prompt.message, prompt.signal);
		prompt.options.forEach((option, i) => console.log(`  ${i + 1}. ${option.label}`));
		const picked = prompt.options[Number(await ask(prompt.message, prompt.signal)) - 1];
		if (picked === undefined) throw new Error("no such choice");
		return picked.id;
	},
};

function signInFor(provider: string | undefined): "openai" {
	if (provider === "claude" || provider === "claude-bridge") throw new Error("Claude Code keeps its own login; run: claude auth login");
	if (provider !== "openai") throw new Error(`name a provider to sign in to: ${SIGN_INS.join(", ")}`);
	return provider;
}

/**
 * The models the signed-in ChatGPT account offers that pi-ai can run, in OpenAI's order, and how many more it offers.
 * The catalog is the account's own (developers.openai.com/siwc, "Models and inference"); listing it spends nothing.
 */
export async function accountModels(models: Models): Promise<{ runnable: { id: string; name: string }[]; others: number }> {
	const auth = await models.getAuth("openai");
	if (auth?.auth.apiKey === undefined) throw new Error("not signed in");
	const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${auth.auth.apiKey}` }, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`OpenAI answered ${response.status} ${response.statusText}`);
	const body = (await response.json()) as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
	const listed = (body.models ?? []).filter((m) => m.visibility === "list" && typeof m.slug === "string");
	const runnable = listed.flatMap((m) => (models.getModel("openai", m.slug!) === undefined ? [] : [{ id: m.slug!, name: m.display_name ?? m.slug! }]));
	return { runnable, others: listed.length - runnable.length };
}

/** Signs in to `provider`, keeps the credential in the data directory, and says which models the account offers. */
export async function login(config: Config, provider: string | undefined): Promise<string[]> {
	const id = signInFor(provider);
	const models = signInModels(config);
	await models.login(id, "oauth", terminal, { getDeviceId: () => deviceId(config.dataDir), agentName: "aludra" });
	const lines = ["", "Signed in with ChatGPT. OpenAI's models in model.choices now run on your ChatGPT plan; a running host uses the sign-in from its next request."];
	try {
		const { runnable, others } = await accountModels(models);
		const offered = new Set(config.model.choices.filter((c) => c.provider === "openai").map((c) => c.id));
		const width = Math.max(0, ...runnable.map((m) => m.id.length)) + 7;
		lines.push("", "Models this account offers:", ...runnable.map((m) => `  ${`openai/${m.id}`.padEnd(width)}  ${m.name}${offered.has(m.id) ? "  (in model.choices)" : ""}`));
		if (others > 0) lines.push(`  and ${others} more this aludra can't run yet`);
		const example = runnable.find((m) => !offered.has(m.id));
		if (example !== undefined) lines.push("", `To offer one in the apps, add it to model.choices in ${config.file ?? "the settings file"}, such as "openai/${example.id}", then restart the host (aludra service install).`);
	} catch (error) {
		lines.push(`(Couldn't list the account's models: ${error instanceof Error ? error.message : String(error)})`);
	}
	return lines;
}

/** Forgets this machine's sign-in to `provider`. */
export async function logout(config: Config, provider: string | undefined): Promise<string[]> {
	const id = signInFor(provider);
	await signInModels(config).logout(id);
	return ["Signed out of ChatGPT on this machine. OpenAI's models stay in the picker but fail until you sign in again."];
}
