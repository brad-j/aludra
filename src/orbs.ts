// Orbs (spike): sessions whose tools run on another machine, a stedding orb, through pi-env's daemon over SSH. The
// agent loop, the transcript and the model stay here; each tool call's environment is a RemoteExecutionEnv on the orb.
// One lazy connection per orb, opened on the first call and reopened after a drop. Nothing here starts or stops orbs.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { RemoteExecutionEnv, type SshConnectOptions, sshConnection } from "@earendil-works/pi-env";

/** How to reach each orb by name: an SSH target whose host key is already in `knownHostsFile`. */
export type OrbTargets = Readonly<Record<string, SshConnectOptions>>;

export function createOrbs(targets: OrbTargets) {
	const connections = new Map<string, ReturnType<typeof sshConnection>>();

	function connection(name: string) {
		let found = connections.get(name);
		if (found === undefined) {
			const target = targets[name];
			if (target === undefined) throw new Error(`no orb named ${name}`);
			found = sshConnection({ ...target, onLog: (text) => console.error(`[orb ${name}] ${text.trimEnd()}`) });
			connections.set(name, found);
		}
		return found.connection;
	}

	return {
		names: () => Object.keys(targets),
		has: (name: string) => targets[name] !== undefined,
		/** The environment for a session on orb `name` working in `cwd`; equal ids see the same files. */
		env(name: string, cwd: string): ExecutionEnv {
			return new RemoteExecutionEnv({ connection: connection(name), id: `stedding:${name}`, cwd });
		},
		close() {
			for (const { connection } of connections.values()) connection.close();
			connections.clear();
		},
	};
}

export type Orbs = ReturnType<typeof createOrbs>;
