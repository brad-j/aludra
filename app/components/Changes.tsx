// A session's changes since it started: totals, then each file, the biggest first, opening to its diff.
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ChangedFile } from "../../src/api-types.ts";
import { fetchDiff, useChanges } from "../lib/changes.ts";
import { age } from "../lib/format.ts";
import { follow, useLive } from "../lib/live.ts";
import { Icon } from "./icons.tsx";
import { useTick } from "./Shell.tsx";

export function ChangesView({ id }: { id: number }) {
	const meta = useLive((s) => (s.followed === id ? s.meta : undefined));
	useEffect(() => {
		follow(id);
		return () => follow(null);
	}, [id]);
	const { changes, error } = useChanges(id, meta?.summary.updatedAt);
	const now = useTick();
	const files = changes?.available ? changes.files : [];
	const most = Math.max(1, ...files.map((f) => f.add + f.del));

	return (
		<>
			<header className="head">
				<Link to="/s/$id" params={{ id: String(id) }} className="icon-btn" aria-label="Back to the session"><Icon.back /></Link>
				<div className="who">
					<h1>Changes</h1>
					<span className="path"><bdi>{meta?.summary.title ?? " "}</bdi></span>
				</div>
			</header>
			<div className="scroll-wrap">
				<div className="scroll">
					<div className="column">
						{changes === undefined && error === undefined && <p className="empty">Loading…</p>}
						{error !== undefined && changes === undefined && <p className="empty">Can't read the changes: {error}</p>}
						{changes?.available === false && <p className="empty">No changes to show: {changes.reason}.</p>}
						{changes?.available === true && (
							<>
								<div className="totals">
									<span className="add">+{changes.add}</span>
									<span className="del">−{changes.del}</span>
									<span className="since">{files.length} file{files.length === 1 ? "" : "s"} since it started{age(changes.since, now) === "now" ? "" : `, ${age(changes.since, now)} ago`}</span>
								</div>
								{files.length === 0 && <p className="empty">Nothing has changed since this session started.</p>}
								<ul className="files">
									{files.map((file) => <FileRow key={file.path} session={id} file={file} most={most} version={meta?.summary.updatedAt} />)}
								</ul>
							</>
						)}
					</div>
				</div>
			</div>
		</>
	);
}

const STATUS: Record<ChangedFile["status"], string> = { added: "new ", deleted: "deleted ", renamed: "renamed ", modified: "" };

function FileRow({ session, file, most, version }: { session: number; file: ChangedFile; most: number; version?: number }) {
	const [open, setOpen] = useState(false);
	const [patch, setPatch] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		fetchDiff(session, file.path).then((d) => !cancelled && setPatch(d.patch), (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
		return () => void (cancelled = true);
	}, [open, session, file.path, version, file.add, file.del]);

	return (
		<li>
			<button className="file-head" aria-expanded={open} onClick={() => setOpen(!open)} title={file.old === undefined ? file.path : `${file.old} → ${file.path}`}>
				<span className="fpath"><bdi>{file.path}</bdi></span>
				<span className="counts">
					{STATUS[file.status] !== "" && <span className="new">{STATUS[file.status]}</span>}
					{file.binary ? <span className="new">binary</span> : <><span className="add">+{file.add}</span> <span className="del">−{file.del}</span></>}
				</span>
				<span className="bar-mini" aria-hidden="true">
					<i className="a" style={{ width: `${(file.add / most) * 100}%` }} />
					<i className="d" style={{ width: `${(file.del / most) * 100}%` }} />
				</span>
			</button>
			<div className="fold" data-open={open}>
				<div>
					{open && (
						<div className="block">
							{patch === undefined ? <pre>{error ?? "Loading…"}</pre> : <Patch text={patch} />}
						</div>
					)}
				</div>
			</div>
		</li>
	);
}

/** A unified diff, without git's file headers: hunks, removed and added lines. */
function Patch({ text }: { text: string }) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith("@@") || line.startsWith("Binary"));
	const body = start === -1 ? [] : lines.slice(start);
	if (body.at(-1) === "") body.pop();
	if (body.length === 0) return <pre>No line changes (a mode or rename only).</pre>;
	return (
		<pre className="patch">
			{body.map((line, i) => (
				<span key={i} className={line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "ins" : line.startsWith("-") ? "rem" : undefined}>{line || " "}</span>
			))}
		</pre>
	);
}
