// What sheets hold: the model and thinking picker, and the project picker.
import { type CSSProperties, useState } from "react";
import type { ModelChoice, Thinking } from "../../src/api-types.ts";
import { age, modelKey, perMillion } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { NO_PROJECT, NO_PROJECT_PATH, projectColor, projectGroups, projectWash, searchProjects } from "../lib/projects.ts";

/** Who runs each provider's models, and how they're paid for. */
const PROVIDERS: Record<string, string> = { "claude-bridge": "Claude Code · your plan", openai: "OpenAI · your ChatGPT plan", openrouter: "OpenRouter · billed per request", faux: "Faux" };

/**
 * The pinned models (the settings' `model.choices`) and the session's own, then the thinking level. Typing searches
 * every model a provider this machine is signed in to has, grouped by provider, with prices where requests are billed.
 * `model` and the changes are `provider/id` (format.ts modelKey).
 */
export function ModelPicker({ model, thinking, onChange }: { model: string; thinking: Thinking; onChange: (change: { model?: string; thinking?: Thinking }) => void }) {
	const bootstrap = useLive((s) => s.bootstrap);
	const [chosen, setChosen] = useState({ model, thinking });
	const [query, setQuery] = useState("");
	const pick = (change: { model?: string; thinking?: Thinking }) => {
		setChosen({ ...chosen, ...change });
		onChange(change);
	};
	const pinned = bootstrap?.models ?? [];
	const catalog = bootstrap?.catalog ?? pinned;
	const current = pinned.some((m) => modelKey(m) === chosen.model) ? undefined : catalog.find((m) => modelKey(m) === chosen.model);
	const top = current === undefined ? pinned : [...pinned, current];
	const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
	const found = words.length === 0 ? [] : catalog.filter((m) => words.every((w) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(w)));
	const groups = [...new Set(found.map((m) => m.provider))].map((provider) => ({ provider, models: found.filter((m) => m.provider === provider).slice(0, 40) }));
	const row = (choice: ModelChoice) => (
		<li key={modelKey(choice)}>
			<button className="pick" role="radio" aria-checked={modelKey(choice) === chosen.model} onClick={() => pick({ model: modelKey(choice) })}>
				<span className="grow">{choice.name}</span>
				{choice.price !== undefined && <span className="sub">{perMillion(choice.price.input)} · {perMillion(choice.price.output)} /M</span>}
			</button>
		</li>
	);
	return (
		<>
			{catalog.length > top.length && <input className="search" type="search" placeholder={`Search ${catalog.length} models`} aria-label="Search models" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />}
			<ul className="list" role="radiogroup" aria-label="Model">
				{words.length === 0 && top.map(row)}
				{groups.map((group) => [<li key={group.provider} className="group-label" role="presentation">{PROVIDERS[group.provider] ?? group.provider}</li>, ...group.models.map(row)])}
				{words.length > 0 && found.length === 0 && <li className="empty">No model matches “{query}”.</li>}
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

/**
 * Projects in groups: Recent (projects with sessions, newest first), then each folder, largest first, picked from a row
 * of chips. Typing searches every folder, name prefixes first, grouped by folder. The amyrlin Mac app's picker follows
 * the same rules (app/lib/projects.ts).
 */
export function ProjectPicker({ current, onPick }: { current: string; onPick: (project: string) => void }) {
	const projects = useLive((s) => s.bootstrap?.projects ?? []);
	const sessions = useLive((s) => s.sessions ?? []);
	const colors = useLive((s) => s.colors);
	const [query, setQuery] = useState("");
	const groups = projectGroups(projects, sessions);
	const [groupId, setGroupId] = useState<string | undefined>(undefined);
	const searching = query.trim() !== "";
	const active = groupId ?? groups[0]?.id;
	const shown = searching ? searchProjects(query, projects, sessions) : groups.filter((g) => g.id === active);
	// "No project" heads the list, for a session that isn't about one repository.
	const showNoProject = !searching || NO_PROJECT.includes(query.trim().toLowerCase());
	return (
		<>
			<input className="search" type="search" placeholder="Find a project" aria-label="Find a project" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
			<div className="chips" role="tablist" aria-label="Project groups">
				{groups.map((g) => (
					<button key={g.id} type="button" role="tab" className="chip" aria-selected={!searching && g.id === active} onClick={() => { setQuery(""); setGroupId(g.id); }}>
						{g.title} <span className="count">{g.entries.length}</span>
					</button>
				))}
			</div>
			<ul className="list">
				{showNoProject && (
					<li>
						<button className="pick project-pick" role="radio" aria-checked={current === NO_PROJECT_PATH} style={{ "--project": projectColor(NO_PROJECT), "--project-wash": projectWash(NO_PROJECT) } as CSSProperties} onClick={() => onPick(NO_PROJECT_PATH)}>
							<span className="swatch" aria-hidden="true" />
							<span className="grow">No project</span>
							<span className="sub">a scratch directory</span>
						</button>
					</li>
				)}
				{shown.map((group) => (
					<li key={group.id}>
						{searching && <p className="group-label">{group.title}</p>}
						<ul className="rows">
							{group.entries.map(({ project, sessions: count, lastActive }) => (
								<li key={project.dir}>
									<button className="pick project-pick" role="radio" aria-checked={project.path === current || project.name === current} style={{ "--project": projectColor(project.name, colors), "--project-wash": projectWash(project.name, colors) } as CSSProperties} onClick={() => onPick(project.path)}>
										<span className="swatch" aria-hidden="true" />
										<span className="grow">{project.name}</span>
										<span className="sub">{count === 0 ? project.path : `${count} session${count === 1 ? "" : "s"}${lastActive === undefined ? "" : ` · ${age(lastActive)}`}`}</span>
									</button>
								</li>
							))}
						</ul>
					</li>
				))}
				{shown.length === 0 && !showNoProject && <li className="empty">{searching ? `No project matches “${query}”.` : "No projects."}</li>}
			</ul>
		</>
	);
}
