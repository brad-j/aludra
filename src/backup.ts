// Copies of the database, made while the host runs: SQLite's online backup through a read-only connection of its own,
// so a copy is consistent even mid-run, written under a temporary name and renamed when whole. The host makes one when
// the newest is older than `backup.everyHours`, and keeps the newest `backup.keep`. `aludra backup` makes one now.
//
// To restore: stop the host (aludra service uninstall, or Ctrl+C), copy a backup over aludra.sqlite in the data
// directory, delete aludra.sqlite-wal and aludra.sqlite-shm beside it, and start the host again.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";

const NAME = /^aludra-(\d{8}T\d{6}Z)\.sqlite$/;

export type BackupFile = { file: string; at: Date };

const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
/** The time in a backup's name; its file's time changes when it's copied or synced. */
const parseStamp = (text: string) => new Date(text.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));

/** The backups in `dir`, newest first. */
export function listBackups(dir: string): BackupFile[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.flatMap((name) => {
			const match = NAME.exec(name);
			return match === null ? [] : [{ file: join(dir, name), at: parseStamp(match[1]!) }];
		})
		.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Copies the database into the backup directory and drops all but the newest `keep`. Returns the new file. */
export async function backupNow(config: Config, now = new Date()): Promise<string> {
	const source = join(config.dataDir, "aludra.sqlite");
	if (!existsSync(source)) throw new Error(`no database at ${source} yet`);
	const { dir, keep } = config.backup;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `aludra-${stamp(now)}.sqlite`);
	const partial = `${file}.partial`;
	const db = new DatabaseSync(source, { readOnly: true });
	try {
		await sqliteBackup(db, partial);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	} finally {
		db.close();
	}
	renameSync(partial, file);
	for (const old of listBackups(dir).slice(keep)) rmSync(old.file, { force: true });
	return file;
}

/** Whether the newest backup is older than `backup.everyHours`, or there's none. */
export function backupDue(config: Config, now = new Date()): boolean {
	const newest = listBackups(config.backup.dir)[0];
	return newest === undefined || now.getTime() - newest.at.getTime() >= config.backup.everyHours * 3_600_000;
}

/** Checks every hour, and a minute after start, whether a backup is due, and makes it. Returns a stop function. */
export function scheduleBackups(config: Config, log: (line: string) => void = console.error): () => void {
	let running = false;
	const check = async () => {
		if (running || !backupDue(config)) return;
		running = true;
		try {
			log(`[backup] ${await backupNow(config)}`);
		} catch (error) {
			log(`[backup] failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			running = false;
		}
	};
	const first = setTimeout(() => void check(), 60_000);
	const hourly = setInterval(() => void check(), 3_600_000);
	first.unref();
	hourly.unref();
	return () => {
		clearTimeout(first);
		clearInterval(hourly);
	};
}
