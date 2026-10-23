// The host's settings, in a sheet. Each field is drawn from the setting's own description (Setting in
// src/api-types.ts), so a setting added on the host shows here without a change. Only what changed is sent.
import { type FormEvent, useEffect, useState } from "react";
import type { Setting, Settings, SettingValue } from "../../src/api-types.ts";
import { modelKey } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";

/** What a field holds while it's edited: lists as one entry per line, numbers as typed. */
type Draft = string | { name: string; roots: string }[];

function draftOf(setting: Setting, value: SettingValue): Draft {
	if (setting.kind === "workspaces") return (value as { name: string; roots: string[] }[]).map((w) => ({ name: w.name, roots: w.roots.join("\n") }));
	if (Array.isArray(value)) return (value as string[]).join("\n");
	return String(value);
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

/** The value a draft means, as the host takes it. A number that isn't one goes as typed, for the host to refuse. */
function valueOf(setting: Setting, draft: Draft): SettingValue {
	if (typeof draft !== "string") return draft.map((w) => ({ name: w.name.trim(), roots: lines(w.roots) }));
	if (setting.kind === "list" || setting.kind === "models") return lines(draft);
	if ((setting.kind === "number" || setting.kind === "integer") && draft.trim() !== "" && Number.isFinite(Number(draft))) return Number(draft);
	return draft.trim();
}

/** A value in a line, for settings shown but not edited here. */
const shown = (value: SettingValue) => (Array.isArray(value) ? (value.length === 0 ? "none" : value.map((v) => (typeof v === "string" ? v : `${v.name}: ${v.roots.join(", ")}`)).join(", ")) : String(value));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function call(method: "GET" | "POST", body?: unknown): Promise<Settings> {
	const response = await fetch("/api/settings", method === "GET" ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error((await response.text()) || `The host answered ${response.status}`);
	return response.json();
}

export function SettingsSheet({ close }: { close: () => void }) {
	const [settings, setSettings] = useState<Settings | undefined>(undefined);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	/** Fields put back to their default, sent as null so the file stops naming them. */
	const [reset, setReset] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<{ text: string; bad?: boolean } | undefined>(undefined);
	const catalog = useLive((s) => s.bootstrap?.catalog ?? []);

	const load = (next: Settings) => {
		setSettings(next);
		setDrafts(Object.fromEntries(next.settings.map((s) => [s.key, draftOf(s, s.value)])));
		setReset(new Set());
	};
	useEffect(() => {
		call("GET").then(load, (error: Error) => setNote({ text: error.message, bad: true }));
	}, []);

	if (settings === undefined) return note === undefined ? <p className="empty">Loading…</p> : <p className="settings-note" data-bad>{note.text}</p>;

	const changes: Record<string, SettingValue | null> = {};
	for (const setting of settings.settings) {
		if (!setting.editable) continue;
		const value = valueOf(setting, drafts[setting.key]!);
		if (reset.has(setting.key) && setting.default !== undefined && same(value, setting.default)) changes[setting.key] = null;
		else if (!same(value, setting.value)) changes[setting.key] = value;
	}
	const dirty = Object.keys(changes).length > 0;

	async function save(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setNote(undefined);
		try {
			const next = await call("POST", { changes });
			load(next);
			setNote({ text: next.restart.length === 0 ? "Saved." : `Saved. ${next.restart.join(", ")} take effect when the host restarts.` });
		} catch (error) {
			setNote({ text: error instanceof Error ? error.message : String(error), bad: true });
		} finally {
			setBusy(false);
		}
	}

	const edit = (key: string, draft: Draft) => {
		setDrafts({ ...drafts, [key]: draft });
		setNote(undefined);
	};
	const toDefault = (setting: Setting) => {
		edit(setting.key, draftOf(setting, setting.default!));
		setReset(new Set(reset).add(setting.key));
	};

	return (
		<form className="settings" onSubmit={(event) => void save(event)}>
			<div className="settings-list">
				{settings.settings.map((setting) => (
					<Field key={setting.key} setting={setting} draft={drafts[setting.key]!} pending={settings.restart.includes(setting.key)} models={catalog.map(modelKey)} onEdit={(draft) => edit(setting.key, draft)} onDefault={() => toDefault(setting)} />
				))}
				<p className="settings-file">{settings.file ?? "No settings file"}</p>
				{settings.errors.map((error) => <p key={error} className="settings-note" data-bad>{error}</p>)}
			</div>
			{note !== undefined && <p className="settings-note" role="status" data-bad={note.bad || undefined}>{note.text}</p>}
			<div className="sheet-actions">
				<button className="btn" type="button" onClick={close}>{dirty ? "Cancel" : "Close"}</button>
				<button className="btn primary" type="submit" disabled={busy || !dirty} data-state={busy ? "loading" : undefined}>Save</button>
			</div>
		</form>
	);
}

/** One setting: its label, control, help, and whether it's the default, file-only or waiting for a restart. */
function Field({ setting, draft, pending, models, onEdit, onDefault }: { setting: Setting; draft: Draft; pending: boolean; models: string[]; onEdit: (draft: Draft) => void; onDefault: () => void }) {
	const id = `setting-${setting.key}`;
	const atDefault = setting.default !== undefined && same(valueOf(setting, draft), setting.default);
	return (
		<div className="setting" data-key={setting.key}>
			<div className="setting-head">
				<label htmlFor={id}>{setting.label}</label>
				{pending && <span className="setting-tag" data-pending>after a restart</span>}
				{!setting.editable && <span className="setting-tag">settings file only</span>}
				{setting.editable && setting.default !== undefined && (atDefault ? <span className="setting-tag">default</span> : <button type="button" className="setting-reset" onClick={onDefault}>Use default</button>)}
			</div>
			{!setting.editable ? <p id={id} className="setting-fixed">{shown(setting.value)}</p> : <Control id={id} setting={setting} draft={draft} models={models} onEdit={onEdit} />}
			<p className="setting-help">{setting.help}</p>
		</div>
	);
}

function Control({ id, setting, draft, models, onEdit }: { id: string; setting: Setting; draft: Draft; models: string[]; onEdit: (draft: Draft) => void }) {
	if (typeof draft !== "string") {
		const change = (i: number, part: Partial<{ name: string; roots: string }>) => onEdit(draft.map((w, j) => (j === i ? { ...w, ...part } : w)));
		return (
			<div className="workspaces" id={id}>
				{draft.map((w, i) => (
					<fieldset key={i} className="workspace">
						<input className="field" aria-label="Workspace name" placeholder="Name" value={w.name} onChange={(event) => change(i, { name: event.target.value })} />
						<textarea className="field" aria-label={`${w.name || "Workspace"} roots, one per line`} placeholder="~/code/*" rows={Math.max(2, lines(w.roots).length + 1)} spellCheck={false} autoCapitalize="off" value={w.roots} onChange={(event) => change(i, { roots: event.target.value })} />
						{draft.length > 1 && <button type="button" className="setting-reset" onClick={() => onEdit(draft.filter((_, j) => j !== i))}>Remove {w.name || "this workspace"}</button>}
					</fieldset>
				))}
				<button type="button" className="btn small" onClick={() => onEdit([...draft, { name: "", roots: "" }])}>Add a workspace</button>
			</div>
		);
	}
	if (setting.kind === "choice") {
		return (
			<div className="seg" role="group" id={id} aria-label={setting.label}>
				{(setting.options ?? []).map((option) => (
					<button key={option} type="button" aria-pressed={option === draft} onClick={() => onEdit(option)}>{option}</button>
				))}
			</div>
		);
	}
	if (setting.kind === "list" || setting.kind === "models") {
		return <textarea className="field" id={id} rows={Math.max(2, lines(draft).length + 1)} placeholder="One per line" spellCheck={false} autoCapitalize="off" value={draft} onChange={(event) => onEdit(event.target.value)} />;
	}
	const numeric = setting.kind === "number" || setting.kind === "integer";
	return (
		<>
			<input
				className="field"
				id={id}
				value={draft}
				inputMode={numeric ? (setting.kind === "integer" ? "numeric" : "decimal") : undefined}
				spellCheck={false}
				autoCapitalize="off"
				list={setting.kind === "model" ? `${id}-models` : undefined}
				onChange={(event) => onEdit(event.target.value)}
			/>
			{setting.kind === "model" && <datalist id={`${id}-models`}>{models.map((m) => <option key={m} value={m} />)}</datalist>}
		</>
	);
}
