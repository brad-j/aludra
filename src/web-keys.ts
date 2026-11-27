// API keys for the web tools (src/web-tools.ts), read from files in the data directory. Brought over from Pi Desktop's
// pi-host.
//
// `tavily.key` (web search) and `jev.key` (the URL reviewer, an OrcaRouter key) each hold one key. They must be
// readable by the owner only (mode 0600): a key file that group or others can read is refused, so a key is never used
// from a place other users can copy it. An environment variable is the fallback when the file is absent
// (TAVILY_API_KEY, ALUDRA_JEV_KEY).
//
// Keys are read at each use, so adding a key file needs no restart.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const TAVILY_KEY_FILE = "tavily.key";
export const JEV_KEY_FILE = "jev.key";

export type KeyResult = { ok: true; key: string } | { ok: false; reason: string };

export function readKey(dataDir: string, file: string, envName: string, env: NodeJS.ProcessEnv = process.env): KeyResult {
	const path = join(dataDir, file);
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		const fromEnv = env[envName]?.trim();
		if (fromEnv) return { ok: true, key: fromEnv };
		return { ok: false, reason: `No key: ${path} doesn't exist and ${envName} isn't set.` };
	}
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		return { ok: false, reason: `${path} is readable by other users. Run: chmod 600 ${path}` };
	}
	const key = readFileSync(path, "utf8").trim();
	if (!key) return { ok: false, reason: `${path} is empty.` };
	return { ok: true, key };
}

/** Whether the key file exists. Doesn't read it. */
export function keyFilePresent(dataDir: string, file: string): boolean {
	return existsSync(join(dataDir, file));
}
