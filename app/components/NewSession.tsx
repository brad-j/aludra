// Starting a session: pick the project from its path, say what to do, and send.
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Thinking } from "../../src/api-types.ts";
import { shortPath } from "../lib/format.ts";
import { actions, useLive } from "../lib/live.ts";
import { Composer } from "./Composer.tsx";
import { Icon } from "./icons.tsx";
import { ModelPicker, ProjectPicker } from "./Pickers.tsx";
import { useUi } from "./Shell.tsx";

const LAST_PROJECT = "aludra.project";

export function NewSession() {
	const bootstrap = useLive((s) => s.bootstrap);
	const sessions = useLive((s) => s.sessions);
	const error = useLive((s) => s.error);
	const ui = useUi();
	const navigate = useNavigate();
	const [project, setProject] = useState(() => (typeof localStorage === "undefined" ? null : localStorage.getItem(LAST_PROJECT)));
	const [agent, setAgent] = useState<{ model?: string; thinking?: Thinking }>({});

	const projects = bootstrap?.projects ?? [];
	// The last project picked, else the one worked in most recently, else the first.
	const recent = [...new Set((sessions ?? []).map((s) => projects.find((p) => p.dir === s.dir)?.path).filter((p) => p !== undefined))];
	const chosen = projects.find((p) => p.path === project) ?? projects.find((p) => p.path === recent[0]) ?? projects[0];
	const model = agent.model ?? bootstrap?.defaults.model.id ?? "";
	const thinking = agent.thinking ?? bootstrap?.defaults.thinking ?? "high";
	const modelName = bootstrap?.models.find((m) => m.id === model)?.name ?? model;

	const pickProject = () =>
		ui.sheet("Project", (close) => (
			<ProjectPicker
				current={chosen?.path ?? ""}
				recent={recent}
				onPick={(path) => {
					setProject(path);
					localStorage.setItem(LAST_PROJECT, path);
					close();
				}}
			/>
		));

	return (
		<>
			<header className="head">
				<button className="icon-btn menu-btn" aria-label="Sessions" onClick={() => ui.setDrawer(true)}><Icon.menu /></button>
				<div className="who">
					<h1>New session</h1>
					<button className="path" onClick={pickProject} aria-label={`Project: ${chosen?.name ?? "none"}. Change project`}>
						<bdi>{chosen === undefined ? "Pick a project" : `${bootstrap?.machine}:${shortPath(chosen.dir)}`}</bdi>
					</button>
				</div>
			</header>
			<div className="scroll-wrap">
				<div className="scroll">
					<div className="column">
						<div className="empty">
							<h2>{chosen?.name ?? "No projects"}</h2>
							Say what it should do. Tap the path to change project.
						</div>
					</div>
				</div>
			</div>
			<footer className="dock">
				{error !== undefined && <p className="dock-error" role="alert">{error}</p>}
				<Composer
					draftKey="new"
					label="What should it do?"
					placeholder="What should it do?"
					sendLabel="Start session"
					onSend={async (text) => {
						if (chosen === undefined) throw new Error("no project");
						const { id } = await actions.start(chosen.path, text, model, thinking);
						await navigate({ to: "/s/$id", params: { id: String(id) } });
					}}
				>
					<span className="grow" />
					<button className="meta" type="button" onClick={() => ui.sheet("Model", () => <ModelPicker model={model} thinking={thinking} onChange={(change) => setAgent((a) => ({ ...a, ...change }))} />)}>
						{modelName} · {thinking}
					</button>
				</Composer>
			</footer>
		</>
	);
}
