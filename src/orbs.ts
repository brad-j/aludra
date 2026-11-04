// Orbs (spike): sessions whose tools run on another machine, a stedding orb, through pi-env's daemon over SSH. The
// agent loop, the transcript and the model stay here; each tool call's environment is a RemoteExecutionEnv on the orb.
//
// One connection per orb, opened by the first call. Reaching the orb wakes it: the SSH target's ProxyCommand is
// `stedding connect N` on the orb's host, which resumes a paused orb before relaying. A connection with nothing in
// flight for `idleMs` is closed, so the host's reaper can pause the orb; the next call opens a new one and wakes it.
// Closing ends the pi-env daemon, which kills the process groups it started, so a server a command left running in
// its own group stops then; one started with setsid survives, and pauses and resumes with the orb.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Connection, RemoteExecutionEnv, type SshConnectOptions, sshConnection } from "@earendil-works/pi-env";

/** How to reach each orb by name: an SSH target whose host key is already in `knownHostsFile`. */
export type OrbTargets = Readonly<Record<string, SshConnectOptions>>;

type Live = { connection: Connection; inFlight: number; timer?: NodeJS.Timeout };

export function createOrbs(targets: OrbTargets, options: { idleMs?: number; connect?: (name: string, target: SshConnectOptions) => Connection } = {}) {
	const idleMs = options.idleMs ?? 60_000;
	const connect = options.connect ?? ((name: string, target: SshConnectOptions) => sshConnection({ ...target, onLog: (text) => console.error(`[orb ${name}] ${text.trimEnd()}`) }).connection);
	const live = new Map<string, Live>();

	function close(name: string) {
		const found = live.get(name);
		if (found === undefined) return;
		clearTimeout(found.timer);
		live.delete(name);
		found.connection.close();
	}

	function idleCheck(name: string, entry: Live) {
		clearTimeout(entry.timer);
		if (entry.inFlight > 0) return;
		entry.timer = setTimeout(() => {
			if (live.get(name) === entry && entry.inFlight === 0) close(name);
		}, idleMs);
		entry.timer.unref();
	}

	function connection(name: string): Connection {
		const found = live.get(name);
		if (found !== undefined) return found.connection;
		const target = targets[name];
		if (target === undefined) throw new Error(`no orb named ${name}`);
		const connection = connect(name, target);
		const entry: Live = { connection, inFlight: 0 };
		// Count requests in flight, so the connection is closed only between them.
		const request = connection.request.bind(connection);
		connection.request = async (...args: Parameters<Connection["request"]>) => {
			entry.inFlight++;
			clearTimeout(entry.timer);
			try {
				return await request(...args);
			} finally {
				entry.inFlight--;
				idleCheck(name, entry);
			}
		};
		live.set(name, entry);
		return connection;
	}

	return {
		names: () => Object.keys(targets),
		has: (name: string) => targets[name] !== undefined,
		/** The environment for a session on orb `name` working in `cwd`; equal ids see the same files. */
		env(name: string, cwd: string): ExecutionEnv {
			return new RemoteExecutionEnv({ connection: connection(name), id: `stedding:${name}`, cwd });
		},
		/** Whether this process holds a connection to orb `name`. */
		connected: (name: string) => live.has(name),
		close() {
			for (const name of Array.from(live.keys())) close(name);
		},
	};
}

export type Orbs = ReturnType<typeof createOrbs>;
