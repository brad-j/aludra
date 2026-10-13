// The CLI's side of the socket: sends one request and prints the server's lines (after gaidin's cli.ts).
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { Config } from "./config.ts";
import { renderSessions, terminalStyle } from "./listing.ts";
import { type ClientMessage, parseServerMessage, socketPathFor } from "./server.ts";

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
				else if (message.type === "sessions") for (const text of renderSessions(message.sessions, message.colors, terminalStyle())) console.log(text);
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
