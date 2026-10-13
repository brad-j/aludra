// Sign-ins to model providers other than Claude Code, which keeps its own: pi-ai's credential store as one owner-only
// JSON file in the data directory, keyed by provider. The CLI writes it at login (src/login.ts) and the host reads it for
// every request, so a sign-in reaches a running host without a restart. A lock file beside it keeps the two from
// writing at once: the host refreshing a token while the CLI signs in again.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** Where the sign-ins are. The protected-path gate already keeps sessions out of any credentials.json. */
export const credentialsFile = (dataDir: string) => join(dataDir, "credentials.json");

/** A lock older than this was left by a process that died holding it. Token refreshes are bounded well inside it. */
const STALE_MS = 120_000;

async function withFileLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
	for (;;) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (age > STALE_MS) rmSync(lock, { force: true });
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
}

/** The credentials in `file`, read afresh each time; writes go to a temporary file and replace it. */
export function fileCredentialStore(file: string): CredentialStore {
	const read = (): Record<string, Credential> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Credential>) : {});
	const write = (all: Record<string, Credential>) => {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		// Named so the protected-path gate covers it too, while it exists.
		const temp = join(dirname(file), `.credentials.${process.pid}.tmp`);
		writeFileSync(temp, `${JSON.stringify(all, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, file);
	};
	let chain: Promise<unknown> = Promise.resolve();
	/** One write at a time: in this process by the chain, across processes by the lock file. */
	const locked = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = chain.then(() => {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			return withFileLock(`${file}.lock`, fn);
		});
		chain = run.catch(() => {});
		return run;
	};
	return {
		read: async (providerId) => read()[providerId],
		list: async () => Object.entries(read()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: (providerId, fn) =>
			locked(async () => {
				const all = read();
				const next = await fn(all[providerId]);
				if (next !== undefined) {
					all[providerId] = next;
					write(all);
				}
				return all[providerId];
			}),
		delete: (providerId) =>
			locked(async () => {
				const all = read();
				if (!(providerId in all)) return;
				delete all[providerId];
				write(all);
			}),
	};
}

/**
 * This machine's installation ID, made on first use and kept in the data directory. Sign in with ChatGPT sends it as
 * the agent host ID, which OpenAI wants stable for each machine and opaque; it isn't a credential.
 */
export function deviceId(dataDir: string): string {
	const file = join(dataDir, "device-id");
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const id = randomUUID();
	try {
		writeFileSync(file, `${id}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		// Another process made it first; theirs stands.
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(file, "utf8").trim();
		throw error;
	}
	return id;
}
