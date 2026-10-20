/**
 * Global prompt history for pi: sent prompts and unsent drafts survive quit and
 * follow you across directories. Recall them with up-arrow or /history.
 *
 * - Sent prompts: captured from the `input` event (raw text, before expansion).
 * - Drafts: captured when the editor is cleared (ctrl+c) or the session ends.
 * - Storage: an append-only JSONL in the pi agent directory, mode 0600.
 *
 * The editor is decorated, not replaced, so whatever editor component is
 * installed keeps working; missing host APIs degrade to a no-op.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	addEntry,
	compactHistory,
	deleteEntry,
	loadHistory,
	type HistoryEntry,
	type HistoryState,
} from "./store.ts";

// Instance markers so a reload or a double load cannot wrap or seed twice.
const INSTRUMENTED = Symbol.for("pi-message-history.instrumented");
const SEEDED = Symbol.for("pi-message-history.seeded");

let sessionCwd = process.cwd();
let known = new Map<string, HistoryEntry>();
// The stored draft the current editor buffer came from, if any. Used to replace
// that draft when the buffer is sent or cleared after an edit.
let activeDraft: string | undefined;

function historyFile(): string {
	return join(getAgentDir(), "message-history.jsonl");
}

function record(state: HistoryState, raw: string): void {
	const text = raw.trim();
	if (!text) return;

	const file = historyFile();
	if (activeDraft && activeDraft !== text) {
		deleteEntry(file, activeDraft);
		known.delete(activeDraft);
	}
	activeDraft = undefined;

	const entry: HistoryEntry = { text, state, cwd: sessionCwd, at: Date.now() };
	addEntry(file, entry);
	known.set(text, entry);
}

type MarkedEditor = EditorComponent & Record<symbol, unknown>;

function instrument<T extends EditorComponent>(editor: T, keybindings: KeybindingsManager): T {
	const marked = editor as MarkedEditor;

	if (!marked[SEEDED]) {
		// Newest first in `known`; reverse, then sort old-to-new so the newest entry
		// ends up at the top of the up-arrow list. The reverse also breaks equal
		// timestamps in favour of the most recently inserted entry.
		for (const entry of [...known.values()].reverse().sort((a, b) => a.at - b.at)) {
			editor.addToHistory?.(entry.text);
		}
		marked[SEEDED] = true;
	}

	if (marked[INSTRUMENTED]) return editor;

	const delegate = editor.handleInput.bind(editor);

	editor.handleInput = (data: string) => {
		try {
			if (keybindings.matches(data, "app.clear")) {
				const draft = editor.getExpandedText?.() ?? editor.getText();
				if (draft.trim()) {
					record("draft", draft);
					editor.addToHistory?.(draft.trim());
				}
			}
		} catch {
			// Draft retention must never break typing.
		}

		const before = editor.getText();
		delegate(data);

		try {
			const recalled =
				keybindings.matches(data, "tui.editor.cursorUp") ||
				keybindings.matches(data, "tui.editor.cursorDown") ||
				keybindings.matches(data, "tui.editor.historyPrevious") ||
				keybindings.matches(data, "tui.editor.historyNext");
			if (!recalled) return;

			const after = editor.getText();
			// A cursor move inside the buffer leaves the text unchanged; only real
			// history navigation changes it. Recomputing on every arrow key would
			// drop the draft link while the user is still editing.
			if (after === before) return;

			const entry = known.get(after);
			activeDraft = entry?.state === "draft" ? after : undefined;

			// History recall leaves the cursor at the start; replayed prompts read
			// better with it at the end.
			if (entry) {
				const internal = editor as T & {
					setTextInternal?: (text: string, cursor?: "start" | "end") => void;
				};
				internal.setTextInternal?.(after, "end");
			}
		} catch {
			// Cursor placement is cosmetic; never break typing over it.
		}
	};

	marked[INSTRUMENTED] = true;
	return editor;
}

function shortenPath(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function relativeAge(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function preview(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

function describe(entry: HistoryEntry): string {
	return `[${entry.state}] ${relativeAge(entry.at)} · ${shortenPath(entry.cwd)} · ${preview(entry.text)}`;
}

export default function messageHistory(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		sessionCwd = ctx.cwd;
		activeDraft = undefined;
		const file = historyFile();
		compactHistory(file);
		known = new Map(loadHistory(file).map((entry) => [entry.text, entry]));

		const { getEditorComponent, setEditorComponent } = ctx.ui;
		if (typeof getEditorComponent !== "function" || typeof setEditorComponent !== "function") return;

		const previous = getEditorComponent();
		setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
			instrument(previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings), keybindings),
		);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		sessionCwd = ctx.cwd;
		record("sent", event.text);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			const text = ctx.ui.getEditorText();
			if (text.trim()) record("draft", text);
		} catch {
			// Best effort: on some exits the editor is already gone.
		}
		compactHistory(historyFile());
	});

	pi.registerCommand("history", {
		description: "Restore a sent prompt or draft from global history",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Message history is available in the interactive TUI.", "warning");
				return;
			}

			const entries = loadHistory(historyFile());
			for (const entry of entries) known.set(entry.text, entry);
			if (entries.length === 0) {
				ctx.ui.notify("No message history yet.", "info");
				return;
			}

			const options = entries.map((entry, index) => `${index + 1}. ${describe(entry)}`);
			const choice = await ctx.ui.select("Message history", options);
			if (!choice) return;

			const entry = entries[Number.parseInt(choice, 10) - 1];
			if (!entry) return;

			ctx.ui.setEditorText(entry.text);
			activeDraft = entry.state === "draft" ? entry.text : undefined;
			ctx.ui.notify(`Restored ${entry.state} from ${shortenPath(entry.cwd)}`, "info");
		},
	});
}
