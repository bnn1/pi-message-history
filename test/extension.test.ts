import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { loadHistory } from "../store.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-message-history-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const historyFile = join(agentDir, "message-history.jsonl");

// Imported after the agent dir is set so storage stays inside the temp directory.
const { default: messageHistory } = await import("../index.ts");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
type Factory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type FakeEditor = {
	getText(): string;
	getExpandedText(): string;
	setText(text: string): void;
	addToHistory(text: string): void;
	handleInput(data: string): void;
	setTextInternal(text: string, cursor?: "start" | "end"): void;
};

function createEditor(): FakeEditor {
	let text = "";
	const history: string[] = [];
	return {
		getText: () => text,
		getExpandedText: () => text,
		setText: (value) => {
			text = value;
		},
		addToHistory: (value) => {
			history.unshift(value);
		},
		handleInput: (data) => {
			if (data === "app.clear") text = "";
			else if (data === "tui.editor.cursorUp") text = history[0] ?? "";
			else if (data === "tui.editor.cursorDown") text = "";
			else text += data;
		},
		setTextInternal: (value) => {
			text = value;
		},
	};
}

const keybindings = {
	matches: (data: string, action: string) => data === action,
} as unknown as KeybindingsManager;

function createUi(editor: FakeEditor) {
	let factory: Factory | undefined;
	return {
		ui: {
			getEditorComponent: () => () => editor as unknown as EditorComponent,
			setEditorComponent: (next: Factory | undefined) => {
				factory = next;
			},
			getEditorText: () => editor.getExpandedText(),
			setEditorText: (value: string) => editor.setText(value),
			select: async () => undefined,
			notify: () => {},
		},
		build: () => {
			assert.ok(factory);
			factory(undefined as unknown as TUI, undefined as unknown as EditorTheme, keybindings);
		},
	};
}

function createContext(cwd: string, ui: object): ExtensionContext {
	return { mode: "tui", cwd, ui } as unknown as ExtensionContext;
}

function createPi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
			return () => {};
		},
		registerCommand(name: string, options: Command) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

function fire(handlers: Map<string, Handler>, name: string, event: unknown, ctx: ExtensionContext): unknown {
	return handlers.get(name)?.(event, ctx);
}

function view(): [string, string][] {
	return loadHistory(historyFile).map((entry) => [entry.text, entry.state]);
}

test("drafts survive sessions and become sent entries when submitted", async () => {
	try {
		const { pi, handlers, commands } = createPi();
		messageHistory(pi);

		// Session 1 in /work/a: type a draft, then clear it with ctrl+c.
		const editorOne = createEditor();
		const uiOne = createUi(editorOne);
		fire(handlers, "session_start", { type: "session_start", reason: "startup" }, createContext("/work/a", uiOne.ui));
		uiOne.build();
		editorOne.handleInput("a draft");
		editorOne.handleInput("app.clear");

		assert.deepEqual(view(), [["a draft", "draft"]]);

		// Session 2 in /work/b: up-arrow recalls the draft from the other directory.
		const editorTwo = createEditor();
		const uiTwo = createUi(editorTwo);
		const ctxTwo = createContext("/work/b", uiTwo.ui);
		fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctxTwo);
		uiTwo.build();
		editorTwo.handleInput("tui.editor.cursorUp");
		assert.equal(editorTwo.getText(), "a draft");

		// Editing and submitting replaces the stale draft with the sent text.
		editorTwo.handleInput(" edited");
		fire(handlers, "input", { type: "input", source: "interactive", text: "a draft edited" }, ctxTwo);
		assert.deepEqual(view(), [["a draft edited", "sent"]]);

		fire(handlers, "input", { type: "input", source: "interactive", text: "a normal prompt" }, ctxTwo);
		assert.deepEqual(view(), [
			["a normal prompt", "sent"],
			["a draft edited", "sent"],
		]);

		// Quitting with text still in the editor stores it as a draft.
		editorTwo.setText("another draft");
		fire(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxTwo);
		editorTwo.setText("");

		// /history labels both states and restores the chosen entry.
		let options: string[] = [];
		let restored: string | undefined;
		const commandCtx = {
			mode: "tui",
			ui: {
				...uiTwo.ui,
				select: async (_title: string, choices: string[]) => {
					options = choices;
					return choices.find((choice) => choice.includes("[draft]"));
				},
				setEditorText: (value: string) => {
					restored = value;
				},
			},
		} as unknown as ExtensionContext;

		await commands.get("history")?.handler("", commandCtx);

		assert.ok(options.some((option) => option.includes("[sent]")));
		assert.ok(options.some((option) => option.includes("[draft]")));
		assert.equal(restored, "another draft");

		// Submitting the restored draft turns it into a sent entry.
		fire(handlers, "input", { type: "input", source: "interactive", text: "another draft" }, ctxTwo);
		assert.deepEqual(view(), [
			["another draft", "sent"],
			["a normal prompt", "sent"],
			["a draft edited", "sent"],
		]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
