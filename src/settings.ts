// The settings as the apps see them: GET and POST /api/settings, the CLI's settings request and `aludra config`, and
// amyrlin's settings.get and settings.set. Each setting describes itself (src/api-types.ts, Setting), so a client draws
// its form from the list rather than knowing aludra's settings.
//
// A change is written to the settings file, checked as the host checks it at start, and the host applies the live ones
// at once (host.settings in src/host.ts). The API's logins, its port, the data directory and Claude Code's path change
// only in the file: a mistake in the first two locks every app out, the third strands the database, and the fourth
// picks the program the host runs.
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Setting, SettingKind, Settings, SettingValue } from "./api-types.ts";
import { type Config, configFor, defaultDataDir, THINKING } from "./config.ts";
import { array, integer, isObject, type Json, literal, number, object, ParseError, type Parser, parse, string } from "./parse.ts";

/** A change the settings can't take, with every reason. */
export class SettingsError extends ParseError {
	readonly errors: string[];
	constructor(errors: string[]) {
		super(errors.join("\n"));
		this.errors = errors;
	}
}

type Spec = {
	key: string;
	label: string;
	help: string;
	kind: SettingKind;
	options?: readonly string[];
	editable: boolean;
	get: (config: Config) => SettingValue;
	default?: (config: Config) => SettingValue;
};

const model = (config: Config) => `${config.model.provider}/${config.model.id}`;
const DEFAULT_CHOICES = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"].map((id) => `claude-bridge/${id}`);

const SPECS: readonly Spec[] = [
	{ key: "workspaces", label: "Workspaces", kind: "workspaces", editable: true, get: (c) => c.workspaces.map(({ name, roots }) => ({ name, roots: [...roots] })),
		help: "Where projects are. Each root is a path pattern: ~ is the home directory, and * matches any one folder name, so ~/code/* makes each folder in ~/code a project." },
	{ key: "model.id", label: "Default model", kind: "model", editable: true, get: model, default: () => "claude-bridge/claude-opus-5-5",
		help: "The model new sessions start on." },
	{ key: "model.thinking", label: "Default thinking", kind: "choice", options: THINKING, editable: true, get: (c) => c.model.thinking, default: () => "high",
		help: "The thinking level new sessions start on." },
	{ key: "model.choices", label: "Pinned models", kind: "models", editable: true, get: (c) => c.model.choices.map((m) => `${m.provider}/${m.id}`), default: () => DEFAULT_CHOICES,
		help: "Models at the top of the model pickers. The default model is added if it isn't listed." },
	{ key: "approvals.hosts", label: "Approval hosts", kind: "list", editable: true, get: (c) => [...c.approvals.hosts], default: () => [],
		help: "Hosts whose ssh, scp, rsync, sftp, mosh or sshfs commands wait for approval. git push always waits." },
	{ key: "approvals.waitHours", label: "Approval wait (hours)", kind: "number", editable: true, get: (c) => c.approvals.waitHours, default: () => 24,
		help: "How long a call waits for an answer before it's refused." },
	{ key: "backup.dir", label: "Backup folder", kind: "path", editable: true, get: (c) => c.backup.dir, default: (c) => join(c.dataDir, "backups"),
		help: "Where copies of the database go. Another disk or a synced folder keeps them safe from this disk failing." },
	{ key: "backup.everyHours", label: "Backup every (hours)", kind: "number", editable: true, get: (c) => c.backup.everyHours, default: () => 24,
		help: "How old the newest copy may get before the host makes another." },
	{ key: "backup.keep", label: "Backups kept", kind: "integer", editable: true, get: (c) => c.backup.keep, default: () => 7,
		help: "How many copies to keep, newest first." },
	{ key: "api.users", label: "Logins", kind: "list", editable: false, get: (c) => [...c.api.users], default: () => [],
		help: "The Tailscale logins the apps let in." },
	{ key: "api.port", label: "Port", kind: "integer", editable: false, get: (c) => c.api.port, default: () => 8724,
		help: "The loopback port of the API and amyrlin's endpoint; tailscale serve points at it." },
	{ key: "claude.path", label: "Claude Code", kind: "path", editable: false, get: (c) => c.claude.path, default: () => "claude",
		help: "The Claude Code program the bridge runs; a bare name is looked up on PATH." },
	{ key: "dataDir", label: "Data folder", kind: "path", editable: false, get: (c) => c.dataDir, default: () => defaultDataDir(),
		help: "Where the database, keys and no-project sessions' folders are." },
];

/** What a running host takes without a restart: the settings clients can change. */
const LIVE = new Set(SPECS.filter((s) => s.editable).map((s) => s.key));

const nonEmpty = (what: string): Parser<string> => (value, at) => {
	const text = string(value, at).trim();
	if (text === "") throw new ParseError(`${at} needs ${what}`);
	return text;
};

/** What each kind takes from a client. */
const PARSERS: Record<SettingKind, (spec: Spec) => Parser<Json>> = {
	text: () => nonEmpty("some text"),
	path: () => nonEmpty("a path"),
	number: () => number,
	integer: () => integer,
	list: () => array(nonEmpty("a name")),
	model: () => nonEmpty("a model"),
	models: () => array(nonEmpty("a model")),
	choice: (spec) => literal(...(spec.options ?? [])),
	workspaces: () => array(object({ name: nonEmpty("a name"), roots: array(nonEmpty("a path pattern")) })),
};

const same = (a: SettingValue, b: SettingValue) => JSON.stringify(a) === JSON.stringify(b);

/** The settings file's JSON, or an empty object when there's no file yet. */
function readRaw(file: string | undefined): { [key: string]: Json } {
	if (file === undefined || !existsSync(file)) return {};
	const raw: Json = JSON.parse(readFileSync(file, "utf8"));
	if (!isObject(raw)) throw new SettingsError([`${file} should hold an object`]);
	return { ...raw };
}

/** Whether `raw` has a value at `key`'s path. */
function has(raw: { readonly [key: string]: Json }, key: string): boolean {
	let at: Json | undefined = raw;
	for (const part of key.split(".")) at = isObject(at) ? at[part] : undefined;
	return at !== undefined;
}

/**
 * The settings in `file` as clients see them. `running` is the host's own, for which saved values it doesn't have yet;
 * without a file, the running settings are all there is.
 */
export function describeSettings(file: string | undefined, running?: Config, env: NodeJS.ProcessEnv = process.env): Settings {
	let raw: { [key: string]: Json } = {};
	let loaded: { config: Config; errors: string[] };
	if (file === undefined && running !== undefined) loaded = { config: running, errors: [] };
	else {
		try {
			raw = readRaw(file);
			loaded = configFor(file !== undefined && existsSync(file) ? readFileSync(file, "utf8") : undefined, env);
		} catch (error) {
			if (!(error instanceof SyntaxError || error instanceof SettingsError)) throw error;
			loaded = { config: running ?? configFor(undefined, env).config, errors: [`${file} isn't readable JSON: ${error.message}`] };
		}
	}
	const { config, errors } = loaded;
	const settings: Setting[] = SPECS.map((spec) => ({
		key: spec.key,
		label: spec.label,
		help: spec.help,
		kind: spec.kind,
		value: spec.get(config),
		...(spec.default === undefined ? {} : { default: spec.default(config) }),
		set: has(raw, spec.key),
		...(spec.options === undefined ? {} : { options: [...spec.options] }),
		editable: spec.editable,
		live: LIVE.has(spec.key),
	}));
	const restart = running === undefined ? [] : SPECS.filter((spec) => !same(spec.get(config), spec.get(running))).map((spec) => spec.key);
	return { file: file ?? null, settings, restart, errors };
}

/**
 * The settings file's text with `changes` made, and the settings it makes. Each change is a key and its new value, or
 * null for the default. Throws a SettingsError for a key clients can't change, a value of the wrong shape, or a file
 * the host wouldn't start with.
 */
export function changeSettings(file: string | undefined, changes: { readonly [key: string]: Json }, env: NodeJS.ProcessEnv = process.env): { text: string; config: Config } {
	if (file === undefined) throw new SettingsError(["the host started without a settings file, so there's nowhere to save; aludra init writes one"]);
	let raw: { [key: string]: Json };
	try {
		raw = readRaw(file);
	} catch (error) {
		if (error instanceof SyntaxError) throw new SettingsError([`${file} isn't readable JSON (${error.message}); fix it by hand first`]);
		throw error;
	}
	const problems: string[] = [];
	const keys = Object.keys(changes);
	if (keys.length === 0) problems.push("no changes");
	for (const key of keys) {
		const spec = SPECS.find((s) => s.key === key);
		if (spec === undefined) {
			problems.push(`there's no setting ${key}; the settings list names them`);
			continue;
		}
		if (!spec.editable) {
			problems.push(`${key} changes only in the settings file, ${file}`);
			continue;
		}
		try {
			const value = changes[key] === null ? undefined : parse(changes[key], PARSERS[spec.kind](spec), key);
			raw = put(raw, key.split("."), value);
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			problems.push(error.message);
		}
	}
	if (problems.length > 0) throw new SettingsError(problems);
	const text = `${JSON.stringify(raw, null, "\t")}\n`;
	const loaded = configFor(text, env);
	if (loaded.errors.length > 0) throw new SettingsError(loaded.errors);
	loaded.config.file = file;
	return { text, config: loaded.config };
}

/** `raw` with `value` at `path`, or without it when undefined; an object left empty goes too. */
function put(raw: { readonly [key: string]: Json }, path: readonly string[], value: Json | undefined): { [key: string]: Json } {
	const [head, ...rest] = path as [string, ...string[]];
	const out = { ...raw };
	const next = rest.length === 0 ? value : put(isObject(raw[head]) ? raw[head] : {}, rest, value);
	if (next === undefined || (isObject(next) && Object.keys(next).length === 0)) delete out[head];
	else out[head] = next;
	return out;
}

/** Writes `text` over the settings file whole: a temporary file beside it, renamed. A link is followed, not replaced. */
export function writeSettings(file: string, text: string): void {
	const target = existsSync(file) ? realpathSync(file) : file;
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
	const partial = `${target}.${process.pid}.partial`;
	writeFileSync(partial, text, { mode });
	chmodSync(partial, mode);
	renameSync(partial, target);
}

/** A setting's value in a line. */
export function showValue(value: SettingValue): string {
	if (!Array.isArray(value)) return String(value);
	if (value.length === 0) return "none";
	return value.map((v) => (typeof v === "string" ? v : `${v.name}: ${v.roots.join(", ")}`)).join(typeof value[0] === "string" ? ", " : "; ");
}

/** `aludra config`: each setting and its value, marked when it's the default, file-only, or waiting for a restart. */
export function renderSettings(settings: Settings, only?: readonly string[]): string[] {
	const shown = settings.settings.filter((setting) => only === undefined || only.includes(setting.key));
	const width = Math.max(...shown.map((setting) => setting.key.length));
	const lines = shown.map((setting) => {
		const notes = [
			!setting.set && setting.default !== undefined ? "default" : undefined,
			setting.editable ? undefined : "file only",
			settings.restart.includes(setting.key) ? "after a restart" : undefined,
		].filter((note) => note !== undefined);
		return `${setting.key.padEnd(width)}  ${showValue(setting.value)}${notes.length === 0 ? "" : `   (${notes.join(", ")})`}`;
	});
	if (only === undefined) lines.push("", `from ${settings.file ?? "no settings file"}`);
	if (settings.restart.length > 0) lines.push(`saved, but the host runs without ${settings.restart.join(", ")} until it restarts: aludra service install`);
	for (const error of settings.errors) lines.push(`! ${error}`);
	return lines;
}

/**
 * The value `aludra config set KEY WORDS...` means for `setting`: JSON when the words are JSON of the right shape
 * (`'[{"name": "code", "roots": ["~/code/*"]}]'`), each word an entry of a list, a number, or the words as text.
 */
export function valueFromWords(setting: Setting, words: readonly string[]): Json {
	const listy = Array.isArray(setting.default ?? setting.value);
	try {
		const parsed: Json = JSON.parse(words.join(" "));
		if (listy ? Array.isArray(parsed) : typeof parsed === typeof setting.value) return parsed;
	} catch {
		// Not JSON: taken as words.
	}
	if (listy) return [...words];
	const number = Number(words[0]);
	if ((setting.kind === "number" || setting.kind === "integer") && words.length === 1 && words[0]!.trim() !== "" && Number.isFinite(number)) return number;
	return words.join(" ");
}
