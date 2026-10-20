# pi-message-history

Persistent prompt history for [pi](https://github.com/earendil-works/pi-coding-agent). Sent prompts and unsent drafts survive quitting and follow you across projects.

- `↑` recalls the newest 100 sent prompts and drafts, in any directory.
- `/history` opens a picker. Every row is tagged `[sent]` or `[draft]`, with age and working directory.
- Drafts are captured when you clear the editor (`ctrl+c`) or end the session.
- Sent prompts are captured when you submit them.

## Install

```bash
pi install npm:pi-message-history
```

Restart pi or run `/reload`. If you still have the old `retain-cleared-draft` file in `~/.pi/agent/extensions/`, remove it so the buffer is not captured twice.

## Usage

- `↑` / `↓` cycle through the merged history.
- `/history` lists it newest first; pick a row to put its text back in the editor.
- Restoring never sends anything. Edit the text and press Enter as usual.
- Sending a restored draft replaces it with the sent entry.
- If you edit a restored draft before sending, the stale draft is removed and the edited text is stored as sent.
- Submitting text that is already in history moves it to the front instead of creating a duplicate.

## What is stored

`~/.pi/agent/message-history.jsonl` (or `$PI_CODING_AGENT_DIR/message-history.jsonl`), with mode `0600`.

Each record holds:

| Field | Meaning |
| --- | --- |
| `text` | Raw prompt text, after `trim()` and before skill/template expansion |
| `state` | `sent` or `draft` |
| `cwd` | Directory where it was captured |
| `at` | Unix timestamp in milliseconds |

- Only the newest 100 entries are loaded.
- The file is an append-only operation log (`add` / `del`), so concurrent pi instances do not overwrite each other. It is compacted on session start and shutdown once it grows.
- History is global by design, not per project.

## Limits

- Restore is TUI-only. Sent prompts are also recorded in RPC and print modes.
- A crash or `kill -9` loses the text currently in the editor. Normal quit and `ctrl+c` are captured.
- Full prompt text is stored on disk, including anything you pasted. Treat the file like a pi session file.
- Overlaps with [`pi-history`](https://www.npmjs.com/package/pi-history), which persists sent prompts and adds `Ctrl+R` search. Do not run both: each wraps the editor and keeps its own store.

## Development

```bash
npm install
npm test        # store tests (node:test)
npm run check   # tsc --noEmit
pi -e ./        # load this directory for one run
```

## License

MIT
