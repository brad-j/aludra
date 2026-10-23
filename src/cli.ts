// The CLI's side of the socket: sends one request and prints the server's lines (after gaidin's cli.ts).
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { Settings } from "./api-types.ts";
import type { Config } from "./config.ts";
import { renderSessions, terminalStyle } from "./listing.ts";
import type { Json } from "./parse.ts";
import { type ClientMessage, isListening, parseServerMessage, socketPathFor } from "./server.ts";
import { changeSettings, describeSettings, renderSettings, SettingsError, valueFromWords, writeSettings } from "./settings.ts";

/**
 * Sends `request` and prints what comes back. Resolves with the exit code: 0 once the server says done, 1 if it says
 * anything else or goes away first. A watch has no end, so it resolves 0 when the server goes away.
 */
export function talk(config: Config, request: ClientMessage, lost?: string): Promise<number> {
	return new Promise((resolvePromise) => {
		const socket = connect(socketPathFor(config));
		socket.once("error", (error) => {
			console.error(`can't reach the aludra server (${error.message}). Start it with: aludra serve`);
			resolvePromise(1);
		});
		socket.once("connect", async () => {
			socket.write(`${JSON.stringify(request)}\n`);
			let status: string | undefined;
			for await (const line of createInterface({ input: socket })) {
				const message = parseServerMessage(line);
				if (message.type === "line") console.log(message.text);
				else if (message.type === "sessions") for (const text of renderSessions(message.sessions, message.colors, terminalStyle(), Date.now(), message.spend)) console.log(text);
				else if (message.type === "done") status = message.status;
			}
			if (status === undefined && request.type !== "watch") {
				console.error(lost ?? "lost the server before it finished.");
				resolvePromise(1);
				return;
			}
			resolvePromise(status === undefined || status === "done" ? 0 : 1);
		});
	});
}

/** The host's settings over the socket, after `changes` if any; a failure's message is thrown. */
function hostSettings(config: Config, changes?: { readonly [key: string]: Json }): Promise<Settings> {
	return new Promise((resolvePromise, reject) => {
		const socket = connect(socketPathFor(config));
		socket.once("error", reject);
		socket.once("connect", async () => {
			socket.write(`${JSON.stringify(changes === undefined ? { type: "settings" } : { type: "settings", changes })}\n`);
			let settings: Settings | undefined;
			const problems: string[] = [];
			for await (const line of createInterface({ input: socket })) {
				const message = parseServerMessage(line);
				if (message.type === "settings") settings = message.settings;
				else if (message.type === "line") problems.push(message.text.replace(/^! /, ""));
			}
			if (settings !== undefined) resolvePromise(settings);
			// A host from before settings answers with an unknown request.
			else reject(new SettingsError(problems.length > 0 ? problems : ["the host didn't send its settings; update it (scripts/install.sh) and restart it"]));
		});
	});
}

const CONFIG_USAGE = "usage: aludra config   or   aludra config set KEY VALUE...   or   aludra config unset KEY";

/**
 * `aludra config`: prints the settings, or changes one with `set KEY VALUE...` (a list takes each word as an entry, or
 * JSON) or `unset KEY` (back to the default). Through the host when it runs, so the change applies at once; otherwise
 * straight to the file, for the next start. Resolves with the exit code.
 */
export async function configCommand(config: Config, words: readonly string[]): Promise<number> {
	const [action, key, ...rest] = words;
	const running = await isListening(socketPathFor(config));
	try {
		if (action === undefined) {
			const settings = running ? await hostSettings(config) : describeSettings(config.file);
			for (const line of renderSettings(settings)) console.log(line);
			if (!running) console.log("the host isn't running, so these are the file's");
			return 0;
		}
		if ((action !== "set" && action !== "unset") || key === undefined || (action === "set") === (rest.length === 0)) {
			console.error(CONFIG_USAGE);
			return 2;
		}
		const setting = describeSettings(config.file).settings.find((s) => s.key === key);
		const changes = { [key]: action === "unset" || setting === undefined ? null : valueFromWords(setting, rest) };
		let settings: Settings;
		if (running) settings = await hostSettings(config, changes);
		else {
			writeSettings(config.file!, changeSettings(config.file, changes).text);
			settings = describeSettings(config.file);
		}
		for (const line of renderSettings(settings, [key])) console.log(line);
		if (!running) console.log("saved; the host isn't running, so it takes this when it starts");
		return 0;
	} catch (error) {
		const lines = error instanceof SettingsError ? error.errors : [error instanceof Error ? error.message : String(error)];
		for (const line of lines) console.error(`aludra config: ${line}`);
		return 1;
	}
}
