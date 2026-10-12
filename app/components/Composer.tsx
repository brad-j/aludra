// The text box at the bottom: it grows with its text, Enter sends on a keyboard (Shift+Enter for a new line), and a
// draft survives switching sessions.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

const drafts = new Map<string, string>();

export type ComposerProps = {
	/** Whose draft this is, so it survives leaving and coming back. */
	draftKey: string;
	placeholder: string;
	label: string;
	sendLabel: string;
	/** Sends the text; the box empties once it resolves. */
	onSend: (text: string) => Promise<unknown>;
	/** Before the send button, left to right: what the row holds besides it. */
	children?: ReactNode;
	/** Hides the send button while the box is empty, for a row whose last button is Stop. */
	sendOnlyWithText?: boolean;
};

export function Composer({ draftKey, placeholder, label, sendLabel, onSend, children, sendOnlyWithText }: ComposerProps) {
	const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
	const [sending, setSending] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);

	useEffect(() => setText(drafts.get(draftKey) ?? ""), [draftKey]);
	useEffect(() => {
		drafts.set(draftKey, text);
		// Browsers without field-sizing grow the box here.
		const el = box.current;
		if (el && !CSS.supports("field-sizing", "content")) {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, [draftKey, text]);

	const empty = text.trim() === "";
	async function send() {
		if (empty || sending) return;
		setSending(true);
		try {
			await onSend(text.trim());
			setText("");
			drafts.delete(draftKey);
		} catch {
			// The error shows above the composer (live.ts); the text stays for another try.
		} finally {
			setSending(false);
		}
	}

	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<label className="visually-hidden" htmlFor={`text-${draftKey}`}>{label}</label>
			<textarea
				id={`text-${draftKey}`}
				ref={box}
				rows={1}
				value={text}
				placeholder={placeholder}
				enterKeyHint="send"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) {
						event.preventDefault();
						void send();
					}
				}}
			/>
			<div className="dock-row">
				{children}
				{!(sendOnlyWithText && empty) && (
					<button className="icon-btn send" type="submit" aria-label={sendLabel} disabled={empty || sending} data-state={sending ? "loading" : undefined}>
						<Icon.send />
					</button>
				)}
			</div>
		</form>
	);
}
