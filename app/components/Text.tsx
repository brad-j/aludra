// Text as the transcript shows it: Markdown answers, highlighted code, and diffs.
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { markdown } from "../lib/markdown.ts";

/** A model's answer. The renderer builds DOM nodes, never HTML, so nothing in an answer can inject markup. */
export function Markdown({ text }: { text: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		ref.current?.replaceChildren(markdown(text));
	}, [text]);
	return <div className="prose" ref={ref} />;
}

const TOKENS = /(\/\/[^\n]*|#[^\n]*$)|("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*')|\b(const|let|var|await|async|function|return|import|from|export|if|else|new|of|for|while|type|interface|class|def|fn|pub|use)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\()/gm;
const CLASSES = ["", "c", "s", "k", "d", "n"];

/** Code with a little highlighting: comments, strings, keywords, numbers and called names. */
export function Code({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(TOKENS)) {
		if (match.index > last) parts.push(text.slice(last, match.index));
		const group = match.findIndex((g, i) => i > 0 && g !== undefined);
		parts.push(<span key={match.index} className={CLASSES[group]}>{match[0]}</span>);
		last = match.index + match[0].length;
	}
	parts.push(text.slice(last));
	return <pre>{parts}</pre>;
}

/** Each edit's old text as removed lines and its new text as added ones. */
export function Diff({ edits }: { edits: readonly { oldText: string; newText: string }[] }) {
	return (
		<pre>
			{edits.flatMap((edit, n) => [
				...(n > 0 ? [<span key={`h${n}`} className="hunk">⋯</span>] : []),
				...edit.oldText.split("\n").map((line, i) => <span key={`${n}-${i}`} className="rem">-{line}</span>),
				...edit.newText.split("\n").map((line, i) => <span key={`${n}+${i}`} className="ins">+{line}</span>),
			])}
		</pre>
	);
}
