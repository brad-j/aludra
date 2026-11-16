// Characters that don't show but reach the model: zero-width spaces and joiners, the word joiner, a byte-order mark
// inside text, and Unicode tag characters (U+E0000 to U+E007F), which spell ASCII invisibly and are the usual way to
// hide instructions in pasted text, a web page or an agent's message. Every message is cleaned of them before it goes
// in (host.submit), whoever sent it, and the agent is told how many were removed, never what they said.
//
// Kept: a zero-width joiner or non-joiner between two visible non-ASCII characters, which is how emoji sequences and
// several scripts (Persian, the Indic scripts) are written. One joiner there carries next to nothing; hidden text
// needs runs of them, and a run is removed whole.

const TAG = /[\u{E0000}-\u{E007F}]/u;
/** Removed wherever they are. */
const ALWAYS = new Set(["\u200B", "\u2060", "\uFEFF", "\u180E", "\u2061", "\u2062", "\u2063", "\u2064"]);
const JOINERS = new Set(["\u200C", "\u200D"]);

/** A visible character a joiner may sit next to: not ASCII, not whitespace, not itself invisible. */
function joinable(char: string | undefined): boolean {
	if (char === undefined || char.codePointAt(0)! < 0x80 || /\s/u.test(char)) return false;
	return !TAG.test(char) && !ALWAYS.has(char) && !JOINERS.has(char) && char !== "\uFE0F";
}

/** `text` without its invisible characters, and how many there were. */
export function stripInvisible(text: string): { text: string; removed: number } {
	const chars = [...text];
	let removed = 0;
	const kept: string[] = [];
	for (let i = 0; i < chars.length; i++) {
		const char = chars[i]!;
		if (TAG.test(char) || ALWAYS.has(char)) {
			removed++;
			continue;
		}
		if (JOINERS.has(char)) {
			// Its neighbors in the text as sent, past an emoji's variation selector: another joiner, an invisible character
			// or ASCII on either side means it isn't joining two visible characters, and it goes.
			let before = i - 1;
			if (chars[before] === "\uFE0F") before--;
			let after = i + 1;
			if (chars[after] === "\uFE0F") after++;
			if (!joinable(chars[before]) || !joinable(chars[after])) {
				removed++;
				continue;
			}
		}
		kept.push(char);
	}
	return { text: removed === 0 ? text : kept.join(""), removed };
}

/** What the agent is told when a message had invisible characters taken out. */
export function invisibleNote(removed: number): string {
	return `[aludra removed ${removed} invisible character${removed === 1 ? "" : "s"} (zero-width or Unicode tag characters) from this message. They can carry instructions the user never saw; what they said isn't kept.]`;
}
