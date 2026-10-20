/**
 * Append-only history store shared by every pi session.
 *
 * Each line is one operation, so concurrent sessions never read-modify-write
 * the same JSON document. Loading replays the operations into the latest view.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HistoryState = "sent" | "draft";

export type HistoryEntry = {
	text: string;
	state: HistoryState;
	cwd: string;
	at: number;
};

/** Matches pi's own editor history cap of 100 entries. */
export const MAX_ENTRIES = 100;
const COMPACT_AFTER_RECORDS = 4 * MAX_ENTRIES;

type AddRecord = HistoryEntry & { op: "add" };
type DeleteRecord = { op: "del"; text: string };

function readLines(file: string): string[] {
	try {
		return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}

function replay(lines: readonly string[]): Map<string, HistoryEntry> {
	const entries = new Map<string, HistoryEntry>();
	for (const line of lines) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			// A torn write or hand edit must not hide every later entry.
			continue;
		}
		if (typeof record !== "object" || record === null) continue;
		const value = record as Record<string, unknown>;
		if (value.op === "del" && typeof value.text === "string") {
			entries.delete(value.text);
			continue;
		}
		if (
			value.op === "add" &&
			typeof value.text === "string" &&
			(value.state === "sent" || value.state === "draft") &&
			typeof value.at === "number" &&
			Number.isFinite(value.at)
		) {
			// Re-insert so the map order also reflects which record is newest.
			entries.delete(value.text);
			entries.set(value.text, {
				text: value.text,
				state: value.state,
				cwd: typeof value.cwd === "string" ? value.cwd : "",
				at: value.at,
			});
		}
	}
	return entries;
}

function newestFirst(entries: Iterable<HistoryEntry>, limit: number): HistoryEntry[] {
	const list = [...entries];
	// Map order is oldest-first, so a later index wins a timestamp tie.
	const order = new Map(list.map((entry, index) => [entry.text, index]));
	return list
		.sort((a, b) => b.at - a.at || (order.get(b.text) ?? 0) - (order.get(a.text) ?? 0))
		.slice(0, limit);
}

export function loadHistory(file: string, limit = MAX_ENTRIES): HistoryEntry[] {
	return newestFirst(replay(readLines(file)).values(), limit);
}

function append(file: string, record: AddRecord | DeleteRecord): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		// Keep prompts private even if an older file was created with wider permissions.
		chmodSync(file, 0o600);
	} catch {
		// Hardening must never break prompt capture on an exotic filesystem.
	}
}

export function addEntry(file: string, entry: HistoryEntry): void {
	const text = entry.text.trim();
	if (!text) return;
	append(file, { op: "add", ...entry, text });
}

export function deleteEntry(file: string, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	append(file, { op: "del", text: trimmed });
}

/** Rewrites the log as one record per surviving entry once it has grown enough. */
export function compactHistory(file: string, limit = MAX_ENTRIES): void {
	const lines = readLines(file);
	if (lines.length <= COMPACT_AFTER_RECORDS) return;

	const kept = newestFirst(replay(lines).values(), limit);
	const body = kept.map((entry) => JSON.stringify({ op: "add", ...entry } satisfies AddRecord)).join("\n");
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, kept.length > 0 ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
		// shortcut: an append that lands between read and rename can hit the replaced
		// inode and be lost; acceptable for a 100-entry convenience log.
		renameSync(temporary, file);
	} catch {
		// Compaction is housekeeping; appending must keep working if it fails.
	}
}
