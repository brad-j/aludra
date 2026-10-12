// The settings: one JSON file, checked at start. Every field has a default, so a missing file runs the defaults.
//
//   {
//     "workspaces": [{ "name": "egwene", "roots": ["~/westwood/Projects/*/*", "~/westwood/Personal/*"] }],
//     "model": { "provider": "claude-bridge", "id": "claude-opus-5-5", "thinking": "high" },
//     "approvals": { "hosts": ["think-1", "think-2", "monitor-01"], "waitHours": 24 },
//     "api": { "port": 8724, "user": "you@example.com" },
//     "dataDir": "~/.local/share/aludra"
//   }
//
// The file is --config, else ALUDRA_CONFIG, else aludra.json beside package.json. ALUDRA_MODEL=faux runs a scripted
// model with no network, and ALUDRA_DATA_DIR replaces the data directory.
//
// `api.user` is the Tailscale login the app's API lets in (src/api.ts); without it the API doesn't start, since every
// request would be refused. `model.choices` are the models the app offers.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { array, integer, literal, number, object, optional, ParseError, parseJson, string } from "./parse.ts";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Thinking = (typeof THINKING)[number];

export type Workspace = { name: string; roots: string[] };

export type Config = {
	/** The file the settings came from, if any. */
	file?: string;
	workspaces: Workspace[];
	model: { provider: "claude-bridge" | "faux"; id: string; thinking: Thinking; choices: string[] };
	/** The app's API on loopback; tailscale serve is the way in. */
	api: { port: number; user?: string };
	/** Calls that wait for Brad: `git push`, and ssh, scp, rsync or sftp naming one of `hosts`. */
	approvals: { hosts: string[]; waitHours: number };
	dataDir: string;
};

export type Loaded = { config: Config; errors: string[] };

/** The project directory, where aludra.json lives by default. */
export const PROJECT_DIR = resolve(import.meta.dirname, "..");

/** `~` and `~/...` as paths in the home directory. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const DEFAULTS: Config = {
	workspaces: [{ name: "egwene", roots: ["~/westwood/Projects/*/*", "~/westwood/Personal/*"] }],
	model: { provider: "claude-bridge", id: "claude-opus-5-5", thinking: "high", choices: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] },
	api: { port: 8724 },
	approvals: { hosts: ["think-1", "think-2", "monitor-01"], waitHours: 24 },
	dataDir: "~/.local/share/aludra",
};

const settingsFile = object({
	workspaces: optional(array(object({ name: string, roots: array(string) }))),
	model: optional(object({ provider: optional(literal("claude-bridge", "faux")), id: optional(string), thinking: optional(literal(...THINKING)), choices: optional(array(string)) })),
	api: optional(object({ port: optional(integer), user: optional(string) })),
	approvals: optional(object({ hosts: optional(array(string)), waitHours: optional(number) })),
	dataDir: optional(string),
});

/** The settings from `text` over the defaults, with the environment on top. */
export function configFor(text?: string, env: NodeJS.ProcessEnv = process.env): Loaded {
	const errors: string[] = [];
	let file: ReturnType<typeof settingsFile> = {};
	if (text !== undefined) {
		try {
			file = parseJson(text, settingsFile, "the settings");
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			errors.push(error.message);
		}
	}
	const config: Config = {
		workspaces: file.workspaces ?? DEFAULTS.workspaces,
		model: { ...DEFAULTS.model, ...file.model },
		api: { ...DEFAULTS.api, ...file.api },
		approvals: { ...DEFAULTS.approvals, ...file.approvals },
		dataDir: expandHome(env.ALUDRA_DATA_DIR ?? file.dataDir ?? DEFAULTS.dataDir),
	};
	if (env.ALUDRA_MODEL === "faux") config.model = { ...config.model, provider: "faux", id: "faux-1", choices: ["faux-1"] };
	if (!config.model.choices.includes(config.model.id)) config.model.choices = [config.model.id, ...config.model.choices];
	const names = config.workspaces.map((w) => w.name);
	if (new Set(names).size !== names.length) errors.push("two workspaces share a name");
	if (config.workspaces.length === 0) errors.push("no workspaces");
	if (!(config.approvals.waitHours > 0)) errors.push("approvals.waitHours should be more than 0");
	if (config.api.port < 1 || config.api.port > 65535) errors.push("api.port should be a port number");
	return { config, errors };
}

/** The settings from the file `--config` names, ALUDRA_CONFIG, or aludra.json beside package.json; defaults without one. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Loaded {
	const named = path ?? env.ALUDRA_CONFIG;
	const file = named === undefined ? join(PROJECT_DIR, "aludra.json") : resolve(expandHome(named));
	if (!existsSync(file)) {
		const loaded = configFor(undefined, env);
		if (named !== undefined) loaded.errors.push(`no settings file at ${file}`);
		return loaded;
	}
	const loaded = configFor(readFileSync(file, "utf8"), env);
	loaded.config.file = file;
	return loaded;
}
