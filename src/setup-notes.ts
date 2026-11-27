// Setup notes: what the user has written about their own setup (machines, services, how their projects connect), for
// sessions to read when a question depends on it. Brought over from Pi Desktop's pi-host, whose notes were compiled
// in; here they're files on the host, so nothing about anyone's machines lives in this repository.
//
// A directory of Markdown files: `setup/` in the data directory, or the settings' `setup.dir`. README.md, if there is
// one, is the map: it goes in the prompt of every no-project session on this machine, cut at MAP_MAX characters, with
// the list of topics after it. Every other `<topic>.md` is a note that read_setup returns whole, up to NOTE_MAX. Files
// are read at each request and each call, so a note edited by hand is used at once. A missing or empty directory adds
// nothing to the prompt and offers no tool.
//
// Only local no-project sessions select the extension (src/host.ts), as with ideas: a project's sessions are about its
// code, and a sandbox session runs untrusted code and shouldn't be handed a map of the user's machines.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export const SETUP_EXTENSION = "aludra-setup";
/** The map's longest prompt text; a longer README.md is cut, and says so. */
export const MAP_MAX = 2000;
/** The longest note read_setup returns. */
export const NOTE_MAX = 40_000;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The topics in `dir`: each `<topic>.md` that's a plain file, README.md left out, sorted. Empty when there's no directory. */
export function setupTopics(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".md") && name !== "README.md")
		.map((name) => name.slice(0, -3))
		.filter((topic) => TOPIC.test(topic) && isFile(join(dir, `${topic}.md`)))
		.sort();
}

/** A plain file, not a link or a directory, so a note can't point the tool at another file. */
function isFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

function readText(path: string, max: number): { text: string; cut: boolean } | undefined {
	if (!isFile(path)) return undefined;
	try {
		const text = readFileSync(path, "utf8").trim();
		return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
	} catch {
		return undefined;
	}
}

/** The prompt section for `dir`: its README.md and the topics, or undefined when it has neither. */
export function setupSection(dir: string): string | undefined {
	const topics = setupTopics(dir);
	const map = readText(join(dir, "README.md"), MAP_MAX);
	if (topics.length === 0 && (map === undefined || map.text === "")) return undefined;
	return [
		"The user keeps notes about their own setup (machines, services, how their projects fit together). Read a topic with read_setup before answering anything that depends on its details; don't guess at them. The notes are written by hand and can be out of date; a project's own files win when they disagree.",
		...(map === undefined || map.text === "" ? [] : [map.text + (map.cut ? "\n[The rest of the map is cut.]" : "")]),
		...(topics.length === 0 ? [] : [`Topics: ${topics.join(", ")}.`]),
	].join("\n\n");
}

/** `read_setup` and the map, over the notes in `dir()`; a host without notes gets nothing from either. */
export function setupExtension(options: { dir: () => string }) {
	const readSetup = defineTool({
		name: "read_setup",
		description: "Read one of the user's notes about their setup, by topic, as the setup section lists them.",
		parameters: Type.Object({ topic: Type.String({ description: "A topic from the list in the setup section, such as machines" }) }),
		replay: "safe",
		async execute({ topic }) {
			const dir = options.dir();
			const topics = setupTopics(dir);
			const known = topics.length === 0 ? "There are no setup notes on this host." : `Topics: ${topics.join(", ")}.`;
			if (!TOPIC.test(topic) || !topics.includes(topic)) return { output: [{ type: "text", text: `No note "${topic}". ${known}` }], isError: true };
			const note = readText(join(dir, `${topic}.md`), NOTE_MAX);
			if (note === undefined) return { output: [{ type: "text", text: `The note "${topic}" couldn't be read. ${known}` }], isError: true };
			return { output: [{ type: "text", text: note.text + (note.cut ? `\n\n[Cut at ${NOTE_MAX} characters.]` : "") }] };
		},
	});
	return defineExtension({
		name: SETUP_EXTENSION,
		tools: [readSetup],
		sections: [section("setup", () => setupSection(options.dir()))],
	});
}
