// A chat's tools (src/host.ts createChat): it reads anything the user can, and changes nothing outside its own
// directory. The file tools refuse a write, edit, move or delete whose path, symbolic links resolved, lands outside
// that directory. Shell commands run under bubblewrap with the whole file system read-only but for that directory and
// a fresh /tmp, in their own process tree, so a command can't write a project either however it's spelled. The network
// is left as it is: a chat may read the web and fetch. Without bubblewrap a chat runs no commands at all.
import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { err, ExecutionError, FileError, ok, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** bubblewrap on PATH, or undefined. */
export function findBwrap(path = process.env.PATH ?? ""): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, "bwrap");
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Not in this one.
		}
	}
	return undefined;
}

/** `path` with its symbolic links resolved, as far up as it exists; the part that doesn't exist yet is kept as written. */
export function realOrParent(path: string): string {
	let head = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(head), ...rest);
		} catch {
			const up = dirname(head);
			if (up === head) return resolve(path);
			rest.unshift(basename(head));
			head = up;
		}
	}
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** bubblewrap's arguments for a command in `cwd` that may write only `writable`. */
export function chatBwrapArgs(writable: string, cwd: string): string[] {
	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
	// The fresh /tmp would hide a working directory under it (as in tests); it comes back read-only.
	if (within(cwd, "/tmp") && !within(cwd, writable)) args.push("--ro-bind", cwd, cwd);
	args.push("--bind", writable, writable, "--unshare-pid", "--die-with-parent", "--new-session", "--chdir", cwd);
	return args;
}

export const CHAT_REFUSAL = "A chat reads anything and changes nothing outside its own directory; start a task to change a project.";

export class ChatEnv extends NodeExecutionEnv {
	readonly writable: string;
	readonly #bwrap: string | undefined;

	/** `writable` must exist. Without `bwrap`, commands are refused. */
	constructor(options: { cwd: string; writable: string; bwrap: string | undefined }) {
		super({ cwd: options.cwd });
		this.writable = realpathSync(options.writable);
		this.#bwrap = options.bwrap;
	}

	async #check(path: string, context: Context): Promise<Result<string, FileError>> {
		const absolute = await this.absolutePath(path, context);
		if (!absolute.ok) return absolute;
		if (within(realOrParent(absolute.value), this.writable)) return ok(absolute.value);
		return err(new FileError("permission_denied", `${absolute.value} is outside this chat's directory, ${this.writable}. ${CHAT_REFUSAL}`, absolute.value));
	}

	override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const checked = await this.#check(path, context);
		return checked.ok ? super.writeFile(path, content, context) : err(checked.error);
	}

	override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const checked = await this.#check(path, context);
		return checked.ok ? super.appendFile(path, content, context) : err(checked.error);
	}

	override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const checked = await this.#check(path, context);
		return checked.ok ? super.truncateFile(path, size, context) : err(checked.error);
	}

	override async renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
		for (const path of [source, destination]) {
			const checked = await this.#check(path, context);
			if (!checked.ok) return err(checked.error);
		}
		return super.renameFile(source, destination, context);
	}

	override async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const checked = await this.#check(path, context);
		return checked.ok ? super.remove(path, options, context) : err(checked.error);
	}

	override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const checked = await this.#check(path, context);
		return checked.ok ? super.createDir(path, options, context) : err(checked.error);
	}

	override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (this.#bwrap === undefined) return err(new ExecutionError("shell_unavailable", `This machine has no bubblewrap (bwrap), which a chat's commands run under, so a chat runs none. ${CHAT_REFUSAL}`));
		const cwd = options?.cwd ?? this.cwd;
		const inner = typeof command === "string" ? ["bash", "-c", command] : [...command];
		return super.exec([this.#bwrap, ...chatBwrapArgs(this.writable, cwd), "--", ...inner], { ...options, cwd }, context);
	}
}
