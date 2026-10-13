// The text box at the bottom: it grows with its text, Enter sends on a keyboard (Shift+Enter for a new line), and a
// draft survives switching sessions. Images come from the attach button, a paste or a drop, and show above the text.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Attached, MAX_IMAGES, prepareImage } from "../lib/images.ts";
import { setError } from "../lib/live.ts";
import { Icon } from "./icons.tsx";

const drafts = new Map<string, string>();
const draftImages = new Map<string, Attached[]>();

export type ComposerProps = {
	/** Whose draft this is, so it survives leaving and coming back. */
	draftKey: string;
	placeholder: string;
	label: string;
	sendLabel: string;
	/** Sends the text and images; the box empties once it resolves. */
	onSend: (text: string, images: Attached[]) => Promise<unknown>;
	/** Before the send button, left to right: what the row holds besides it. */
	children?: ReactNode;
	/** Hides the send button while the box is empty, for a row whose last button is Stop. */
	sendOnlyWithText?: boolean;
	/** A second way to use the text, first in the row, such as saving it as an idea; the box empties once it resolves.
	 * It takes text only, so it's off while images are attached. */
	secondary?: { label: string; icon: ReactNode; onSend: (text: string) => Promise<unknown> };
};

export function Composer({ draftKey, placeholder, label, sendLabel, onSend, children, sendOnlyWithText, secondary }: ComposerProps) {
	const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
	const [images, setImages] = useState<Attached[]>(() => draftImages.get(draftKey) ?? []);
	const [sending, setSending] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setText(drafts.get(draftKey) ?? "");
		setImages(draftImages.get(draftKey) ?? []);
	}, [draftKey]);
	useEffect(() => void draftImages.set(draftKey, images), [draftKey, images]);
	useEffect(() => {
		drafts.set(draftKey, text);
		// Browsers without field-sizing grow the box here.
		const el = box.current;
		if (el && !CSS.supports("field-sizing", "content")) {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, [draftKey, text]);

	const empty = text.trim() === "" && images.length === 0;

	async function attach(files: readonly Blob[]) {
		const wanted = files.filter((file) => file.type.startsWith("image/"));
		if (wanted.length === 0) return;
		const room = MAX_IMAGES - images.length;
		if (wanted.length > room) setError(`A message takes at most ${MAX_IMAGES} images`);
		try {
			const added = await Promise.all(wanted.slice(0, Math.max(0, room)).map(prepareImage));
			setImages((before) => [...before, ...added].slice(0, MAX_IMAGES));
		} catch (error) {
			setError(error instanceof Error ? error.message : "That image couldn't be read");
		}
	}

	function remove(index: number) {
		setImages((before) => {
			URL.revokeObjectURL(before[index]!.url);
			return before.filter((_, i) => i !== index);
		});
	}

	async function send(how: (text: string, images: Attached[]) => Promise<unknown> = onSend) {
		if (empty || sending) return;
		setSending(true);
		try {
			await how(text.trim(), images);
			setText("");
			drafts.delete(draftKey);
			for (const image of images) URL.revokeObjectURL(image.url);
			setImages([]);
			draftImages.delete(draftKey);
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
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes("Files")) event.preventDefault();
			}}
			onDrop={(event) => {
				if (event.dataTransfer.files.length === 0) return;
				event.preventDefault();
				void attach([...event.dataTransfer.files]);
			}}
		>
			{images.length > 0 && (
				<ul className="attachments" aria-label="Attached images">
					{images.map((image, index) => (
						<li key={image.url}>
							<img src={image.url} alt={`Image ${index + 1}`} />
							<button type="button" className="remove" aria-label={`Remove image ${index + 1}`} onClick={() => remove(index)}><Icon.close /></button>
						</li>
					))}
				</ul>
			)}
			<label className="visually-hidden" htmlFor={`text-${draftKey}`}>{label}</label>
			<textarea
				id={`text-${draftKey}`}
				ref={box}
				rows={1}
				value={text}
				placeholder={placeholder}
				enterKeyHint="send"
				onChange={(event) => setText(event.target.value)}
				onPaste={(event) => {
					const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
					if (files.length === 0) return;
					event.preventDefault();
					void attach(files);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) {
						event.preventDefault();
						void send();
					}
				}}
			/>
			<input
				ref={picker}
				className="visually-hidden"
				type="file"
				accept="image/*"
				multiple
				tabIndex={-1}
				aria-hidden
				onChange={(event) => {
					void attach([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
			<div className="dock-row">
				<button className="icon-btn" type="button" aria-label="Attach images" disabled={sending || images.length >= MAX_IMAGES} onClick={() => picker.current?.click()}>
					<Icon.image />
				</button>
				{secondary !== undefined && (
					<button className="icon-btn" type="button" aria-label={secondary.label} disabled={text.trim() === "" || images.length > 0 || sending} onClick={() => void send((t) => secondary.onSend(t))}>
						{secondary.icon}
						<span>Idea</span>
					</button>
				)}
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
