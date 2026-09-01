---
name: cue-ipc-channel
description: Add, change, or review an IPC channel between cue's renderer and main process. Use whenever a change touches preload.js, ipcMain.handle/on, window.cue.*, or exposes new data to the UI — the preload allowlist and main-side validation are easy to forget and fail silently.
---

# Adding an IPC channel in cue

The renderer has no node access. Every capability it has comes through `preload.js` → `window.cue`. Three files must agree or the feature dies silently.

## The four steps

1. **`preload.js`** — expose the call in `contextBridge.exposeInMainWorld('cue', {...})`.
   - `invoke` for request/response, `send` for fire-and-forget.
   - If main pushes events *to* the renderer, the channel name **must** be added to the `allowed` array inside `on()`. An unlisted channel is dropped with no error — this is the #1 silent failure here.
2. **`main.js`** — register `ipcMain.handle('name', ...)` (matching `invoke`) or `ipcMain.on('name', ...)` (matching `send`), in the `-------- IPC --------` section.
3. **`renderer/renderer.js`** — call `cue.xxx()` / subscribe with `cue.on('channel', cb)`.
4. **`test/`** — if the logic is non-trivial, it belongs in a `src/` module that a `node --test` file can import without Electron. Don't put testable logic inline in `main.js`.

## Validate on the main side — always

The renderer is the untrusted side of this boundary: a compromised page (or a future feature that renders remote content) inherits the whole `window.cue` surface. Main must not trust anything it receives.

- **Enum/id inputs**: look them up in a table, never use them to build a path. `whisper:model-delete` does this right — `requireWhisperModel(modelId)` before touching the filesystem.
- **URLs**: allowlist the protocol. `ipcMain.on('open-pane')` currently passes straight to `shell.openExternal` — if you extend it, restrict to `https:`, `ms-settings:`, `x-apple.systempreferences:`.
- **File paths**: never accept one from the renderer. The pattern here is main opens the `dialog`, main reads the file, main returns parsed text (`profile:pickDocument` → `pickAndParseDocument`).
- **Settings patches**: `settings:set` deep-merges a renderer-supplied object into the store. Anything security-relevant you add there needs its own validation (see `normalizeBaseUrl` in `src/openai-compatible.js` for the shape to copy) and a length cap for free-text (`MAX_AI_RULES_CHARS`).

## Data that must not cross into the renderer

`settings:get` returns the full settings object including `apiKeys` — the UI needs it to populate the password fields. Don't widen that pattern. New sensitive values should stay in main and be exposed as booleans/counts unless the UI genuinely must display them.

## Checklist before you finish

- [ ] preload exposes it AND (for push events) the channel is in the `on()` allowlist
- [ ] main validates every argument it did not itself produce
- [ ] handler cannot throw an unhandled rejection (`invoke` rejections surface in the renderer; `send` handlers must not throw)
- [ ] `npm test` green, `node --check` clean on all four files
