// Each project's color: an OKLCH hue from its name, or one picked for it. The web app (app/lib/projects.ts), the CLI
// (src/listing.ts) and the amyrlin Mac app (its AmyrlinCore ProjectColor) share these rules, so a project is one color
// everywhere.

/** OKLCH hues, ordered so neighbors differ. Red and amber are left out: they mean failed and waiting. */
export const HUES = [300, 165, 50, 240, 330, 110, 190, 355, 265, 140, 215];

/** FNV-1a over the name's UTF-8, as the Mac app hashes it. */
export function hueIndex(name: string): number {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(name)) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return Number(hash % BigInt(HUES.length));
}

/** The project's hue: the one picked for it (name to hue index), else its name's. */
export const hueOf = (name: string, picked: Readonly<Record<string, number>> = {}): number => HUES[picked[name] ?? hueIndex(name)] ?? HUES[hueIndex(name)]!;
