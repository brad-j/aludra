// Sessions and ideas by machine and project, the project that most needs Brad first, and this device's notifications at
// the foot. A drawer on phones, a column on the desk.
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Idea, SessionSummary } from "../../src/api-types.ts";
import { age, shortPath, URGENCY } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { type PushHere, pushHere, sendTest, turnOff, turnOn } from "../lib/push.ts";
import { Icon, Mark } from "./icons.tsx";
import { IdeaRow } from "./Ideas.tsx";
import { useTick, useUi } from "./Shell.tsx";

export function Drawer() {
	const sessions = useLive((s) => s.sessions);
	const ideas = useLive((s) => s.ideas);
	const machine = useLive((s) => s.bootstrap?.machine);
	const connection = useLive((s) => s.connection);
	const { setDrawer } = useUi();
	const params = useParams({ strict: false });
	const current = params.id === undefined ? undefined : Number(params.id);
	const now = useTick();

	type Group = { project: string; dir: string; sessions: SessionSummary[]; ideas: Idea[] };
	const groups = new Map<string, Group>();
	const group = (project: string, dir: string) => groups.get(dir) ?? groups.set(dir, { project, dir, sessions: [], ideas: [] }).get(dir)!;
	for (const session of sessions ?? []) group(session.project, session.dir).sessions.push(session);
	for (const idea of ideas) group(idea.project, idea.dir).ideas.push(idea);
	// A project with only ideas comes after every project with a session.
	const rank = (g: Group) => Math.min(9, ...g.sessions.map((s) => URGENCY[s.state]));
	const latest = (g: Group) => Math.max(0, ...g.sessions.map((s) => s.updatedAt), ...g.ideas.map((i) => i.createdAt));
	const ordered = [...groups.values()].sort((a, b) => rank(a) - rank(b) || latest(b) - latest(a));

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
				{sessions !== undefined && ordered.length === 0 && <p className="empty">No sessions yet. Start one with +.</p>}
				{ordered.map(({ project, dir, sessions: list, ideas: projectIdeas }) => (
					<section className="dir" key={dir}>
						<div className="dir-head">
							<span className="name">{project}</span>
							<span className="where">{shortPath(dir)}</span>
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
							{projectIdeas.map((idea) => <IdeaRow key={`idea-${idea.id}`} idea={idea} />)}
						</ul>
					</section>
				))}
			</div>
			<div className="drawer-foot"><Notifications /></div>
		</aside>
	);
}

const PUSH_TEXT: Record<PushHere, string> = {
	unsupported: "Notifications aren't supported in this browser",
	"install-first": "Add aludra to the Home Screen for notifications",
	blocked: "Notifications are blocked in this device's settings",
	off: "Notifications are off on this device",
	on: "Notifications are on",
};

/** This device's notifications: whether it gets them, and a switch. */
function Notifications() {
	const [state, setState] = useState<PushHere | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	useEffect(() => void pushHere().then(setState), []);

	async function run(action: () => Promise<unknown>, done?: string) {
		setBusy(true);
		setNote(undefined);
		try {
			await action();
			setState(await pushHere());
			if (done !== undefined) setNote(done);
		} catch (error) {
			setNote(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	if (state === undefined) return null;
	return (
		<div className="notifications">
			<div className="notifications-row">
				<span className="grow">{PUSH_TEXT[state]}</span>
				{state === "off" && <button className="btn small" disabled={busy} onClick={() => void run(turnOn)}>Turn on</button>}
				{state === "on" && <button className="btn small" disabled={busy} onClick={() => void run(async () => { const { devices, inSeconds } = await sendTest(); setNote(`A test goes to ${devices} device${devices === 1 ? "" : "s"} in ${inSeconds} seconds. Lock the phone now: iOS shows no banner while aludra is open.`); })}>Test</button>}
				{state === "on" && <button className="btn small" disabled={busy} onClick={() => void run(turnOff)}>Turn off</button>}
			</div>
			{note !== undefined && <p className="notifications-note" role="status">{note}</p>}
		</div>
	);
}
