// A session's changes since it started (src/changes.ts), read again as its run moves on.
import { useEffect, useRef, useState } from "react";
import type { Changes } from "../../src/api-types.ts";

async function get<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) throw new Error((await response.text()) || `The host answered ${response.status}`);
	return response.json();
}

export const fetchDiff = (session: number, path: string) => get<{ path: string; patch: string }>(`/api/sessions/${session}/changes/diff?path=${encodeURIComponent(path)}`);

/**
 * Session `id`'s changes, fetched again when `version` (its last activity) moves, at most every few seconds: each read
 * snapshots the project's files.
 */
export function useChanges(id: number, version: number | undefined): { changes?: Changes; error?: string } {
	const [state, setState] = useState<{ changes?: Changes; error?: string }>({});
	const last = useRef(0);
	const mounted = useRef(true);
	useEffect(() => () => void (mounted.current = false), []);
	useEffect(() => {
		const wait = Math.max(0, last.current + 3000 - Date.now());
		// A read already under way still lands: every answer is the session's changes as of when it was read.
		const timer = setTimeout(() => {
			last.current = Date.now();
			get<Changes>(`/api/sessions/${id}/changes`).then(
				(changes) => mounted.current && setState({ changes }),
				(error) => mounted.current && setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) })),
			);
		}, wait);
		return () => clearTimeout(timer);
	}, [id, version]);
	return state;
}
