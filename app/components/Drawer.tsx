// Sessions by machine and project, the project that most needs Brad first. A drawer on phones, a column on the desk.
import { Link, useParams } from "@tanstack/react-router";
import type { SessionSummary } from "../../src/api-types.ts";
import { age, shortPath, URGENCY } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { Icon, Mark } from "./icons.tsx";
import { useTick, useUi } from "./Shell.tsx";

export function Drawer() {
	const sessions = useLive((s) => s.sessions);
	const machine = useLive((s) => s.bootstrap?.machine);
	const connection = useLive((s) => s.connection);
	const { setDrawer } = useUi();
	const params = useParams({ strict: false });
	const current = params.id === undefined ? undefined : Number(params.id);
	const now = useTick();

	const groups = new Map<string, SessionSummary[]>();
	for (const session of sessions ?? []) groups.set(session.project, [...(groups.get(session.project) ?? []), session]);
	const rank = (list: SessionSummary[]) => Math.min(...list.map((s) => URGENCY[s.state]));
	const latest = (list: SessionSummary[]) => Math.max(...list.map((s) => s.updatedAt));
	const ordered = [...groups].sort(([, a], [, b]) => rank(a) - rank(b) || latest(b) - latest(a));

	return (
		<aside className="drawer" aria-label="Sessions">
			<div className="drawer-head">
				<h2>Sessions</h2>
				<Link to="/" className="icon-btn" aria-label="New session" onClick={() => setDrawer(false)}>
					<Icon.plus />
				</Link>
			</div>
			<div className="drawer-list">
				<div className="machine">
					<span className="dot" data-connection={connection} aria-hidden="true" />
					{machine ?? "…"} · {connection === "open" ? "local" : connection === "connecting" ? "connecting" : "reconnecting"}
				</div>
				{sessions !== undefined && sessions.length === 0 && <p className="empty">No sessions yet. Start one with +.</p>}
				{ordered.map(([project, list]) => (
					<section className="dir" key={project}>
						<div className="dir-head">
							<span className="name">{project}</span>
							<span className="where">{shortPath(list[0]!.dir)}</span>
						</div>
						<ul className="rows">
							{list
								.sort((a, b) => URGENCY[a.state] - URGENCY[b.state] || b.updatedAt - a.updatedAt)
								.map((session) => (
									<li key={session.id}>
										<Link
											to="/s/$id"
											params={{ id: String(session.id) }}
											className="session-row"
											data-state={session.state}
											aria-current={session.id === current ? "page" : undefined}
											onClick={() => setDrawer(false)}
										>
											<Mark state={session.state} />
											<span>
												<span className="title">{session.title}</span>
												<span className="line">{session.line || "\u00a0"}</span>
											</span>
											<span className="age">{age(session.updatedAt, now)}</span>
										</Link>
									</li>
								))}
						</ul>
					</section>
				))}
			</div>
		</aside>
	);
}
