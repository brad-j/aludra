// A chat's tools (src/host.ts createChat): it reads anything the user can, and changes nothing outside its own
// directory. The file tools refuse a write, edit, move or delete whose path, symbolic links resolved, lands outside
// that directory. Shell commands run with the whole file system read-only but for that directory and a temporary one:
// on Linux under bubblewrap, with a fresh /tmp and their own process tree; on macOS under Seatbelt (sandbox-exec),
// with the user's temporary folders writable. So a command can't write a project either, however it's spelled. The
// network is left as it is: a chat may read the web and fetch. With neither, a chat runs no commands at all.
import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { err, ExecutionError, FileError, ok, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** How a chat's commands are confined: bubblewrap on Linux, Seatbelt on macOS, with the program's path. */
export type Confine = { kind: "bwrap" | "seatbelt"; path: string };

/** This machine's way to confine a chat's commands, or undefined when it has none. */
export function findConfine(path = process.env.PATH ?? "", platform = process.platform): Confine | undefined {
	if (platform === "darwin") {
		const found = findOnPath("sandbox-exec", `${path}${delimiter}/usr/bin`);
		return found === undefined ? undefined : { kind: "seatbelt", path: found };
	}
	const found = findBwrap(path);
	return found === undefined ? undefined : { kind: "bwrap", path: found };
}

/** bubblewrap on PATH, or undefined. */
export function findBwrap(path = process.env.PATH ?? ""): string | undefined {
	return findOnPath("bwrap", path);
}

function findOnPath(name: string, path: string): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
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

/**
 * Seatbelt's profile for a chat's commands: everything allowed but writing files, which is allowed only in OWN (its
 * own directory, a parameter), the user's temporary folders, and the devices a shell writes to. Checked on macOS
 * 26: a write to a project or the home directory fails with "Operation not permitted".
 */
export const CHAT_SEATBELT = [
	"(version 1)",
	"(allow default)",
	"(deny file-write*)",
	'(allow file-write* (subpath (param "OWN")) (subpath "/private/tmp") (subpath "/private/var/folders")',
	'  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
].join("\n");

export const CHAT_REFUSAL = "A chat reads anything and changes nothing outside its own directory; start a task to change a project.";

export class ChatEnv extends NodeExecutionEnv {
	readonly writable: string;
	readonly #confine: Confine | undefined;

	/** `writable` must exist. Without `confine`, commands are refused. */
	constructor(options: { cwd: string; writable: string; confine: Confine | undefined }) {
		super({ cwd: options.cwd });
		this.writable = realpathSync(options.writable);
		this.#confine = options.confine;
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
		const confine = this.#confine;
		if (confine === undefined) return err(new ExecutionError("shell_unavailable", `This machine has neither bubblewrap (Linux) nor sandbox-exec (macOS), which a chat's commands run under, so a chat runs none. ${CHAT_REFUSAL}`));
		const cwd = options?.cwd ?? this.cwd;
		const inner = typeof command === "string" ? ["bash", "-c", command] : [...command];
		if (confine.kind === "seatbelt") return super.exec([confine.path, "-D", `OWN=${this.writable}`, "-p", CHAT_SEATBELT, ...inner], { ...options, cwd }, context);
		return super.exec([confine.path, ...chatBwrapArgs(this.writable, cwd), "--", ...inner], { ...options, cwd }, context);
	}
}
