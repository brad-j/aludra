// Ideas: first messages kept for later under their project. Start runs one as a session; tapping its text shows all of
// it, with Start and Delete.
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Idea } from "../../src/api-types.ts";
import { actions } from "../lib/live.ts";
import { Mark } from "./icons.tsx";
import { useUi } from "./Shell.tsx";

export function IdeaList({ ideas }: { ideas: readonly Idea[] }) {
	return (
		<ul className="rows">
			{ideas.map((idea) => <IdeaRow key={idea.id} idea={idea} />)}
		</ul>
	);
}

export function IdeaRow({ idea }: { idea: Idea }) {
	const ui = useUi();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);

	async function start() {
		setBusy(true);
		try {
			const { id } = await actions.startIdea(idea.id);
			ui.setDrawer(false);
			await navigate({ to: "/s/$id", params: { id: String(id) } });
		} finally {
			setBusy(false);
		}
	}

	const show = () =>
		ui.sheet(`Idea · ${idea.project}`, (close) => (
			<>
				<p className="idea-text">{idea.text}</p>
				<div className="sheet-actions">
					<button className="btn" onClick={() => { close(); void actions.deleteIdea(idea.id); }}>Delete</button>
					<button className="btn primary" onClick={() => { close(); void start(); }}>Start</button>
				</div>
			</>
		));

	return (
		<li className="idea-row">
			<Mark state="idea" />
			<button className="text" onClick={show} title={idea.text}>{idea.text}</button>
			<button className="btn small" disabled={busy} data-state={busy ? "loading" : undefined} onClick={() => void start()}>Start</button>
		</li>
	);
}
