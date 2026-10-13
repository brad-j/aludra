// One session: its transcript, what's running, and the composer for steering, queueing, following up and stopping.
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChanges } from "../lib/changes.ts";
import type { Item, SessionMeta } from "../../src/api-types.ts";
import { type Call, callLabel, duration, shortPath, STATE_LABEL, summarize, tokens } from "../lib/format.ts";
import { actions, follow, useLive } from "../lib/live.ts";
import { Composer } from "./Composer.tsx";
import { Icon, Mark } from "./icons.tsx";
import { ModelPicker } from "./Pickers.tsx";
import { useTick, useUi } from "./Shell.tsx";
import { Code, Diff, Markdown } from "./Text.tsx";

/** A session's new title, saved on the host; the drawer and the Mac app hear of it. */
function RenameForm({ session, title, close }: { session: number; title: string; close: () => void }) {
	const [text, setText] = useState(title);
	const [busy, setBusy] = useState(false);
	async function save(event: FormEvent) {
		event.preventDefault();
		if (text.trim() === "" || busy) return;
		setBusy(true);
		try {
			await actions.rename(session, text);
			close();
		} catch {
			setBusy(false);
		}
	}
	return (
		<form onSubmit={(event) => void save(event)}>
			<input className="field" aria-label="Title" value={text} maxLength={200} autoFocus onChange={(event) => setText(event.target.value)} onFocus={(event) => event.target.select()} />
			<div className="sheet-actions">
				<button className="btn" type="button" onClick={close}>Cancel</button>
				<button className="btn primary" type="submit" disabled={busy || text.trim() === ""} data-state={busy ? "loading" : undefined}>Rename</button>
			</div>
		</form>
	);
}

type Block = { kind: "item"; item: Item } | { kind: "round"; key: string; calls: Call[] };

/** Consecutive calls go together as a round. */
function blocksOf(items: readonly Item[]): Block[] {
	const blocks: Block[] = [];
	for (const item of items) {
		const last = blocks.at(-1);
		if (item.kind === "call" && last?.kind === "round") last.calls.push(item);
		else if (item.kind === "call") blocks.push({ kind: "round", key: item.id, calls: [item] });
		else blocks.push({ kind: "item", item });
	}
	return blocks;
}

/** Whether the last item already shows the run working: a call that runs, or an answer being written. */
const showsWork = (item: Item | undefined) => (item?.kind === "call" && (item.status === "running" || item.status === "pending")) || (item?.kind === "answer" && item.streaming === true);

export function SessionView({ id }: { id: number }) {
	const items = useLive((s) => (s.followed === id ? s.items : []));
	const meta = useLive((s) => (s.followed === id ? s.meta : undefined));
	const error = useLive((s) => s.error);
	const machine = useLive((s) => s.bootstrap?.machine ?? "");
	const ui = useUi();
	const { changes } = useChanges(id, meta?.summary.updatedAt);
	const changed = changes?.available ? changes.files.length : 0;

	useEffect(() => {
		follow(id);
		return () => follow(null);
	}, [id]);

	const running = meta?.summary.state === "running" || meta?.summary.state === "waiting";
	const blocks = blocksOf(items);
	const { scroller, atBottom, toBottom } = useStickToBottom(id, items);

	function more() {
		ui.sheet(meta?.summary.title ?? "Session", (close) => (
			<ul className="list">
				<li>
					<button className="pick" onClick={() => { close(); setTimeout(rename, 320); }}>
						<span className="grow">Rename</span>
					</button>
				</li>
				<li>
					<button className="pick" onClick={() => { close(); setTimeout(chooseModel, 320); }}>
						<span className="grow">Model and thinking</span>
						<span className="sub">{meta?.model.name} · {meta?.thinking}</span>
					</button>
				</li>
				{running && (
					<li>
						<button className="pick danger" onClick={() => { close(); void actions.stop(id); }}>
							<span className="grow">Stop the run</span>
						</button>
					</li>
				)}
			</ul>
		));
	}

	function rename() {
		ui.sheet("Rename", (close) => <RenameForm session={id} title={meta?.summary.title ?? ""} close={close} />);
	}

	function chooseModel() {
		if (meta === undefined) return;
		ui.sheet("Model", () => <ModelPicker model={meta.model.id} thinking={meta.thinking} onChange={(change) => void actions.configure(id, change)} />);
	}

	return (
		<>
			<header className="head">
				<button className="icon-btn menu-btn" aria-label="Sessions" onClick={() => ui.setDrawer(true)}><Icon.menu /></button>
				<div className="who">
					<h1>{meta?.summary.title ?? " "}</h1>
					<Link to="/s/$id/changes" params={{ id: String(id) }} className="path" aria-label={`Changes in ${meta?.summary.dir ?? "the project"}`}>
						<bdi>{meta === undefined ? " " : `${machine}:${shortPath(meta.summary.dir)}`}</bdi>
					</Link>
				</div>
				<Link to="/s/$id/changes" params={{ id: String(id) }} className="icon-btn" aria-label={`Changes: ${changed} file${changed === 1 ? "" : "s"}`}>
					<Icon.files />
					{changed > 0 && <span className="count">{changed}</span>}
				</Link>
				<button className="icon-btn" aria-label="Session menu" onClick={more}><Icon.more /></button>
			</header>
			<div className="scroll-wrap">
				<div className="scroll" ref={scroller}>
					<div className="column">
						{meta === undefined && items.length === 0 && <p className="empty">Loading…</p>}
						{blocks.map((block, index) => {
							const last = index === blocks.length - 1;
							if (block.kind === "round") return <Round key={block.key} calls={block.calls} open={last && running} />;
							return <ItemView key={block.item.id} item={block.item} session={id} />;
						})}
						{running && meta?.retry !== undefined && <p className="note">Retrying: {meta.retry.error}</p>}
						{meta?.summary.state === "running" && !showsWork(items.at(-1)) && <p className="note working"><Mark state="running" /> Working</p>}
					</div>
				</div>
				<button className="to-bottom" data-show={!atBottom} aria-label="Jump to the latest" onClick={toBottom}><Icon.down /></button>
			</div>
			<footer className="dock">
				{error !== undefined && <p className="dock-error" role="alert">{error}</p>}
				{meta?.approval !== undefined && <Approval approval={meta.approval} />}
				{(meta?.queued.length ?? 0) > 0 && (
					<ul className="queued">
						{meta!.queued.map((q) => (
							<li key={q.id}>
								<span className="tag">{q.mode === "steer" ? "Steer" : "Next"}</span>
								<span className="grow">{q.text}</span>
								<button className="icon-btn" aria-label="Take back" onClick={() => void actions.withdraw(id, q.id)}><Icon.close /></button>
							</li>
						))}
					</ul>
				)}
				<SessionComposer id={id} meta={meta} running={running} onMore={more} onModel={chooseModel} />
			</footer>
		</>
	);
}

function SessionComposer({ id, meta, running, onMore, onModel }: { id: number; meta?: SessionMeta; running: boolean; onMore: () => void; onModel: () => void }) {
	const [mode, setMode] = useState<"steer" | "followUp">("steer");
	return (
		<Composer
			draftKey={`s${id}`}
			label={running ? "Steer or queue a message" : "Follow up"}
			placeholder={running ? (mode === "steer" ? "Steer the current run…" : "Queue for when it's done…") : "Follow up…"}
			sendLabel="Send"
			sendOnlyWithText={running}
			onSend={(text) => actions.send(id, text, running ? mode : "followUp")}
		>
			<button className="icon-btn" type="button" aria-label="Session menu" onClick={onMore}><Icon.plus /></button>
			{running && (
				<button className="mode" type="button" onClick={() => setMode(mode === "steer" ? "followUp" : "steer")} aria-label={mode === "steer" ? "Sends as a steer; tap to queue instead" : "Queues for when it's done; tap to steer instead"}>
					{mode === "steer" ? "Steer" : "Queue"}
				</button>
			)}
			<span className="grow" />
			{meta !== undefined && (
				<button className="meta" type="button" onClick={onModel}>
					{meta.model.name} · {meta.thinking} · {tokens(meta.context.used)}
				</button>
			)}
			{running && <button className="icon-btn stop" type="button" aria-label="Stop the run" onClick={() => void actions.stop(id)}><Icon.stop /></button>}
		</Composer>
	);
}

function ItemView({ item, session }: { item: Item; session: number }) {
	switch (item.kind) {
		case "user":
			return <div className="user">{item.text}</div>;
		case "answer":
			return (
				<>
					<Markdown text={item.text} />
					{!item.streaming && <CopyButton text={item.text} />}
				</>
			);
		case "compacted":
			return <p className="divider">Earlier messages summarized</p>;
		case "call":
			return null;
		case "failure":
			return <Failure item={item} session={session} />;
	}
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="copy-row">
			<button
				className="icon-btn"
				aria-label={copied ? "Copied" : "Copy answer"}
				data-state={copied ? "success" : undefined}
				onClick={() => {
					void navigator.clipboard?.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <Icon.check /> : <Icon.copy />}
			</button>
		</div>
	);
}

/** A failure says what it is: a refusal with its request ID, a rate limit, or an error with a retry. */
function Failure({ item, session }: { item: Extract<Item, { kind: "failure" }>; session: number }) {
	const [copied, setCopied] = useState(false);
	if (item.type === "stopped") return <p className="note">Stopped. Nothing else runs until you send something.</p>;
	const title = item.type === "refused" ? "Refused by the model's safeguards" : item.type === "rate-limit" ? "Rate limited" : "The request failed";
	return (
		<section className="failure" data-type={item.type}>
			<h3><Mark state="failed" />{title}</h3>
			<p>{item.message}</p>
			{item.requestId !== undefined && (
				<div className="ref">
					<code>{item.requestId}</code>
					<button className="btn small" data-state={copied ? "success" : undefined} onClick={() => { void navigator.clipboard?.writeText(item.requestId!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
						{copied ? "Copied" : "Copy ID"}
					</button>
				</div>
			)}
			{item.type !== "refused" && (
				<div className="next">
					<button className="btn small" onClick={() => void actions.send(session, "Continue where you left off.", "followUp")}>Retry</button>
				</div>
			)}
		</section>
	);
}

/** A round of calls: rows while it runs, one summary line once it's done, opened by a tap. */
function Round({ calls, open: live }: { calls: Call[]; open: boolean }) {
	const done = calls.every((c) => c.status === "done" || c.status === "error");
	const [open, setOpen] = useState(false);
	if (!done || live) return <div className="calls">{calls.map((call) => <CallView key={call.id} call={call} />)}</div>;
	const failed = calls.some((c) => c.status === "error");
	return (
		<div className="calls">
			<button className="fold-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Mark state={failed ? "failed" : "done"} />
				<span className="what">{summarize(calls)}</span>
				<span className="took">{calls.length} call{calls.length === 1 ? "" : "s"}</span>
				<Icon.chevron />
			</button>
			<div className="fold" data-open={open}>
				<div>{open && calls.map((call) => <CallView key={call.id} call={call} />)}</div>
			</div>
		</div>
	);
}

const seen = new Map<string, number>();

function CallView({ call }: { call: Call }) {
	const [open, setOpen] = useState(false);
	if (call.status === "running" || call.status === "pending") return <LiveCall call={call} />;
	const detail = detailOf(call);
	return (
		<>
			<div className="call-row">
				<Mark state={call.status === "error" ? "failed" : "done"} />
				<span className="tool">{call.tool}</span>
				{detail === null ? (
					<span className="arg" title={callLabel(call)}>{callLabel(call)}</span>
				) : (
					<button className="arg" aria-expanded={open} title={callLabel(call)} onClick={() => setOpen(!open)}>{callLabel(call)}</button>
				)}
				<span className={call.status === "error" ? "took bad" : "took"}>{call.ms === undefined ? "" : duration(call.ms)}</span>
			</div>
			{detail !== null && (
				<div className="fold" data-open={open}>
					<div>{open && <div className="block">{detail}</div>}</div>
				</div>
			)}
		</>
	);
}

/** What opening a call shows: an edit's diff, a write's content, or the output. */
function detailOf(call: Call) {
	const { edits, content } = call.args;
	if (call.tool === "edit" && Array.isArray(edits) && call.status !== "error") return <Diff edits={edits as { oldText: string; newText: string }[]} />;
	if (call.tool === "write" && typeof content === "string" && call.status !== "error") return <Code text={content} />;
	if (call.output !== undefined && call.output !== "") return <pre>{call.output}</pre>;
	return null;
}

/** A running call: its command and the tail of its output, at a fixed height so the page doesn't move. */
function LiveCall({ call }: { call: Call }) {
	const now = useTick(1000);
	if (!seen.has(call.id)) seen.set(call.id, now);
	const tail = (call.output ?? "").split("\n").filter((line) => line !== "").slice(-4).join("\n");
	return (
		<div className="block live" aria-live="polite">
			<div className="block-head">
				<span className="glyph">&gt;_</span>
				<span className="label">{call.tool}</span>
				<span className="preview">{callLabel(call)}</span>
				<Mark state="running" />
				<span className="preview">{Math.round((now - seen.get(call.id)!) / 1000)}s</span>
			</div>
			<pre className="tail">{tail}</pre>
		</div>
	);
}

function Approval({ approval }: { approval: NonNullable<SessionMeta["approval"]> }) {
	const [busy, setBusy] = useState(false);
	const decide = async (allow: boolean) => {
		setBusy(true);
		try {
			await actions.decide(approval.id, allow);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="approval" aria-label="Approval">
			<div className="what"><Mark state="waiting" /><span>Wants to run {approval.summary}. {STATE_LABEL.waiting}.</span></div>
			<pre>{approval.command}</pre>
			<div className="buttons">
				<button className="btn" disabled={busy} onClick={() => void decide(false)}>Deny</button>
				<button className="btn wait" disabled={busy} onClick={() => void decide(true)}>Allow {approval.summary}</button>
			</div>
		</section>
	);
}

/** Keeps the transcript at its newest line while it's there, and says when it isn't. */
function useStickToBottom(id: number, items: readonly Item[]) {
	const scroller = useRef<HTMLDivElement>(null);
	const stuck = useRef(true);
	const [atBottom, setAtBottom] = useState(true);

	useEffect(() => {
		stuck.current = true;
	}, [id]);

	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const onScroll = () => {
			const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			stuck.current = bottom;
			setAtBottom(bottom);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		// Content that grows under a stuck view (a streaming answer, an opened block) keeps it at the bottom.
		const observer = new ResizeObserver(() => {
			if (stuck.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(el.firstElementChild!);
		return () => {
			el.removeEventListener("scroll", onScroll);
			observer.disconnect();
		};
	}, []);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stuck.current) el.scrollTop = el.scrollHeight;
	}, [items]);

	const toBottom = () => {
		const el = scroller.current;
		if (!el) return;
		stuck.current = true;
		el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
	};
	return { scroller, atBottom, toBottom };
}
