// What sheets hold: the model and thinking picker, and the project picker.
import { useState } from "react";
import type { ModelChoice, Thinking } from "../../src/api-types.ts";
import { shortPath } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";

export function ModelPicker({ model, thinking, onChange }: { model: string; thinking: Thinking; onChange: (change: { model?: string; thinking?: Thinking }) => void }) {
	const bootstrap = useLive((s) => s.bootstrap);
	const [chosen, setChosen] = useState({ model, thinking });
	const pick = (change: { model?: string; thinking?: Thinking }) => {
		setChosen({ ...chosen, ...change });
		onChange(change);
	};
	return (
		<>
			<ul className="list" role="radiogroup" aria-label="Model">
				{(bootstrap?.models ?? []).map((choice: ModelChoice) => (
					<li key={choice.id}>
						<button className="pick" role="radio" aria-checked={choice.id === chosen.model} onClick={() => pick({ model: choice.id })}>
							<span className="grow">{choice.name}</span>
						</button>
					</li>
				))}
			</ul>
			<p className="group-label">Thinking</p>
			<div className="seg" role="group" aria-label="Thinking">
				{(bootstrap?.thinking ?? []).map((level) => (
					<button key={level} type="button" aria-pressed={level === chosen.thinking} onClick={() => pick({ thinking: level })}>
						{level}
					</button>
				))}
			</div>
		</>
	);
}

export function ProjectPicker({ current, recent, onPick }: { current: string; recent: readonly string[]; onPick: (project: string) => void }) {
	const projects = useLive((s) => s.bootstrap?.projects ?? []);
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const rank = (name: string) => (recent.includes(name) ? recent.indexOf(name) : recent.length);
	const matches = projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)).sort((a, b) => rank(a.name) - rank(b.name));
	return (
		<>
			<input className="search" type="search" placeholder="Find a project" aria-label="Find a project" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
			<ul className="list">
				{matches.map((project) => (
					<li key={project.dir}>
						<button className="pick" role="radio" aria-checked={project.path === current || project.name === current} onClick={() => onPick(project.path)}>
							<span className="grow">{project.name}</span>
							<span className="sub">{shortPath(project.dir)}</span>
						</button>
					</li>
				))}
				{matches.length === 0 && <li className="empty">No project matches “{query}”.</li>}
			</ul>
		</>
	);
}
