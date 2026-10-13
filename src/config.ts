// The settings: one JSON file, checked at start. Everything but the workspaces has a default.
//
//   {
//     "workspaces": [{ "name": "code", "roots": ["~/code/*", "~/work/*/*"] }],
//     "model": { "provider": "claude-bridge", "id": "claude-opus-5-5", "thinking": "high" },
//     "claude": { "path": "claude" },
//     "approvals": { "hosts": ["prod-db", "router"], "waitHours": 24 },
//     "api": { "port": 8724, "users": ["you@example.com"] },
//     "dataDir": "~/.local/share/aludra"
//   }
//
// The file is --config, else ALUDRA_CONFIG, else config.json in aludra's settings directory ($XDG_CONFIG_HOME/aludra,
// or ~/.config/aludra). ALUDRA_MODEL=faux runs a scripted model with no network, and ALUDRA_DATA_DIR replaces the
// data directory, which is ~/Library/Application Support/aludra on macOS and $XDG_DATA_HOME/aludra (or
// ~/.local/share/aludra) elsewhere.
//
// `api.users` are the Tailscale logins the app's API and the amyrlin endpoint let in (src/api.ts); without any, the API
// doesn't start, since every request would be refused. Everyone listed sees and runs every session. `model.choices`
// are the models the app offers. `claude.path` is the Claude Code the bridge runs, the user's own install and login;
// a bare name is looked up on PATH.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { array, integer, isObject, type Json, literal, number, object, optional, ParseError, parseJson, string } from "./parse.ts";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Thinking = (typeof THINKING)[number];

export type Workspace = { name: string; roots: string[] };

export type Config = {
	/** The file the settings came from, if any. */
	file?: string;
	workspaces: Workspace[];
	model: { provider: "claude-bridge" | "faux"; id: string; thinking: Thinking; choices: string[] };
	/** The Claude Code binary the bridge runs. */
	claude: { path: string };
	/** The app's API on loopback; tailscale serve is the way in. */
	api: { port: number; users: string[] };
	/** Calls that wait for the user: `git push`, and ssh, scp, rsync or sftp naming one of `hosts`. */
	approvals: { hosts: string[]; waitHours: number };
	dataDir: string;
};

export type Loaded = { config: Config; errors: string[] };

/** `~` and `~/...` as paths in the home directory. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Where the settings file is when none is named. */
export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "aludra", "config.json");
}

/** Where the database, keys and scratch directories go when the settings don't say. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return join(homedir(), "Library", "Application Support", "aludra");
	return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "aludra");
}

const DEFAULTS = {
	model: { provider: "claude-bridge", id: "claude-opus-5-5", thinking: "high", choices: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] },
	claude: { path: "claude" },
	api: { port: 8724, users: [] },
	approvals: { hosts: [], waitHours: 24 },
} satisfies Omit<Config, "workspaces" | "dataDir">;

const EXAMPLE_WORKSPACE = '"workspaces": [{ "name": "code", "roots": ["~/code/*"] }]';

const settingsFile = object({
	workspaces: optional(array(object({ name: string, roots: array(string) }))),
	model: optional(object({ provider: optional(literal("claude-bridge", "faux")), id: optional(string), thinking: optional(literal(...THINKING)), choices: optional(array(string)) })),
	claude: optional(object({ path: optional(string) })),
	api: optional(object({ port: optional(integer), users: optional(array(string)) })),
	approvals: optional(object({ hosts: optional(array(string)), waitHours: optional(number) })),
	dataDir: optional(string),
});

/** The settings from `text` over the defaults, with the environment on top. */
export function configFor(text?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Loaded {
	const errors: string[] = [];
	let file: ReturnType<typeof settingsFile> = {};
	if (text !== undefined) {
		try {
			file = parseJson(text, settingsFile, "the settings");
			// Unnamed fields are ignored, so the old single login would quietly turn the API off.
			const raw = JSON.parse(text) as Json;
			if (isObject(raw) && isObject(raw.api) && "user" in raw.api) errors.push('api.user is now api.users, a list: "users": ["you@example.com"]');
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			errors.push(error.message);
		}
	}
	const config: Config = {
		workspaces: file.workspaces ?? [],
		model: { ...DEFAULTS.model, ...file.model },
		claude: { ...DEFAULTS.claude, ...file.claude, path: expandHome(file.claude?.path ?? DEFAULTS.claude.path) },
		api: { ...DEFAULTS.api, ...file.api },
		approvals: { ...DEFAULTS.approvals, ...file.approvals },
		dataDir: expandHome(env.ALUDRA_DATA_DIR ?? file.dataDir ?? defaultDataDir(env, platform)),
	};
	if (env.ALUDRA_MODEL === "faux") config.model = { ...config.model, provider: "faux", id: "faux-1", choices: ["faux-1"] };
	if (!config.model.choices.includes(config.model.id)) config.model.choices = [config.model.id, ...config.model.choices];
	const names = config.workspaces.map((w) => w.name);
	if (new Set(names).size !== names.length) errors.push("two workspaces share a name");
	if (config.workspaces.length === 0) errors.push(`no workspaces: name the folders that hold your projects, such as ${EXAMPLE_WORKSPACE}`);
	if (!(config.approvals.waitHours > 0)) errors.push("approvals.waitHours should be more than 0");
	if (config.api.port < 1 || config.api.port > 65535) errors.push("api.port should be a port number");
	return { config, errors };
}

/** The settings from the file `--config` names, ALUDRA_CONFIG, or the default file. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Loaded {
	const named = path ?? env.ALUDRA_CONFIG;
	const file = named === undefined ? defaultConfigFile(env) : resolve(expandHome(named));
	if (!existsSync(file)) {
		const loaded = configFor(undefined, env);
		loaded.errors.unshift(`no settings file at ${file}`);
		return loaded;
	}
	const loaded = configFor(readFileSync(file, "utf8"), env);
	loaded.config.file = file;
	return loaded;
}
