import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	addEntry,
	compactHistory,
	deleteEntry,
	loadHistory,
	MAX_ENTRIES,
	type HistoryEntry,
} from "../store.ts";

let directory: string;
let file: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-message-history-"));
	file = join(directory, "history.jsonl");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function entry(text: string, state: "sent" | "draft", at: number, cwd = "/work"): HistoryEntry {
	return { text, state, cwd, at };
}

test("loads entries newest first", () => {
	addEntry(file, entry("older", "sent", 1));
	addEntry(file, entry("newer", "draft", 2));

	assert.deepEqual(
		loadHistory(file).map((item) => item.text),
		["newer", "older"],
	);
});

test("the same text updates in place instead of duplicating", () => {
	addEntry(file, entry("fix the bug", "draft", 1));
	addEntry(file, entry("fix the bug", "sent", 2));

	const entries = loadHistory(file);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.state, "sent");
	assert.equal(entries[0]?.at, 2);
});

test("delete removes an entry", () => {
	addEntry(file, entry("keep", "sent", 1));
	addEntry(file, entry("drop", "draft", 2));
	deleteEntry(file, "drop");

	assert.deepEqual(
		loadHistory(file).map((item) => item.text),
		["keep"],
	);
});

test("a torn or corrupt line does not hide later entries", () => {
	addEntry(file, entry("before", "sent", 1));
	appendFileSync(file, "{not json\n");
	addEntry(file, entry("after", "draft", 2));

	assert.deepEqual(
		loadHistory(file).map((item) => item.text),
		["after", "before"],
	);
});

test("caps the view at the newest entries", () => {
	for (let index = 1; index <= MAX_ENTRIES + 20; index += 1) {
		addEntry(file, entry(`prompt-${index}`, "sent", index));
	}

	const entries = loadHistory(file);
	assert.equal(entries.length, MAX_ENTRIES);
	assert.equal(entries[0]?.text, `prompt-${MAX_ENTRIES + 20}`);
	assert.equal(entries.at(-1)?.text, "prompt-21");
});

test("compaction rewrites the log and preserves the newest view", () => {
	for (let index = 1; index <= 450; index += 1) {
		addEntry(file, entry(`prompt-${index}`, index % 2 === 0 ? "sent" : "draft", index));
	}
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 450);

	compactHistory(file);

	const lines = readFileSync(file, "utf8").trim().split("\n");
	assert.equal(lines.length, MAX_ENTRIES);
	assert.equal(loadHistory(file)[0]?.text, "prompt-450");
});

test("trims text and skips blank entries", () => {
	addEntry(file, entry("  padded  ", "draft", 1));
	addEntry(file, entry("   ", "sent", 2));

	assert.deepEqual(
		loadHistory(file).map((item) => item.text),
		["padded"],
	);
});

test("creates the history file with private permissions", () => {
	if (process.platform === "win32") return;
	addEntry(file, entry("secret", "sent", 1));
	assert.equal(statSync(file).mode & 0o777, 0o600);
});
