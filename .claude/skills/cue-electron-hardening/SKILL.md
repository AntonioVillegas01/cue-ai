---
name: cue-electron-hardening
description: Electron-specific security review for cue — the renderer/main trust boundary, credential storage, shell and child-process calls, and window/navigation guards. Use when reviewing or changing main.js window options, preload.js, shell.openExternal, spawn calls, or anything that stores an API key.
---

# Electron hardening rules for cue

cue holds the user's provider API keys, screenshots their whole display, and records both sides of private conversations. The renderer is the side an attacker reaches first, so the boundary is where review effort goes.

## Baseline that must stay true

`main.js` `webPreferences` — for **every** window, including `permWin` and any new one:

```js
contextIsolation: true,      // required
nodeIntegration: false,      // required
sandbox: true,               // preferred; preload only needs contextBridge + ipcRenderer
preload: path.join(__dirname, 'preload.js')
```

Both HTML entry points ship a CSP `<meta>` (`renderer/index.html`, `renderer/permissions.html`). `script-src 'self'` with **no** `'unsafe-inline'` is what stops injected markup from executing — never add `'unsafe-inline'` to `script-src` to make something work.

## Navigation and window guards

A renderer that can navigate or `window.open()` to a remote origin carries the whole `window.cue` API — including `settingsGet()`, which returns the API keys — to that origin. cue currently has no guard for this. When adding windows or link handling, install:

```js
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', (e, url) => {
  if (!url.startsWith('file://')) e.preventDefault();
});
```

## `shell.openExternal`

`ipcMain.on('open-pane')` forwards a renderer-supplied URL straight to `shell.openExternal`. Today every caller passes a hardcoded settings-pane URI, but the channel accepts anything and `openExternal` will hand `file:`, `smb:` or a registered custom scheme to the OS. Any change in this area should allowlist the protocol:

```js
const ALLOWED = ['https:', 'ms-settings:', 'x-apple.systempreferences:'];
```

## Rendering model output

`renderMarkdown` in `renderer/renderer.js` escapes first (`esc`) and only then re-introduces `<code>`/`<strong>`. **Order matters** — escape, then decorate. Never introduce a markdown feature that emits attributes from model text (links, images, raw HTML passthrough): model output is attacker-influenceable via the screen and the transcript, and an attribute sink plus a preload API is a real exfiltration path even under CSP.

## Credentials

Keys live in plaintext in `cue-data.json` under `app.getPath('userData')`, written with default permissions. If you touch `src/store.js`:

- write the file with `{ mode: 0o600 }`,
- prefer `safeStorage.encryptString` / `decryptString` (Keychain / DPAPI / libsecret) for the `apiKeys` block, with a plaintext-read migration path for existing files,
- keep keys out of prompts, error strings, `recordEvent` payloads and `describeState`,
- `deepMerge` in `store.js` merges renderer-supplied patches key by key — reject `__proto__`, `constructor` and `prototype` keys if you touch it.

## Child processes and downloads

- `whisper-server` is spawned with an argument array (never a shell string), `windowsHide: true`, bound to `127.0.0.1` on an ephemeral port behind a 24-byte random URL path. Keep all four properties.
- Every downloaded artifact is pinned by **size + SHA-256** before use (`whisper-model-manager.js`, `scripts/prepare-whisper-runtime.js`). A new download without a pinned hash is not acceptable — this code runs binaries.
- Model ids from the renderer are resolved through the catalog (`requireWhisperModel`) and never concatenated into a path.

## The app-link boundary

`vendor/app-link` authenticates the *user account*, not the calling program — Node can't read Unix-socket peer credentials. That is why consent is required for reads as well as actions, and why the consent sheet says "a program identifying itself as X". Don't weaken either: no silent grants, no auto-approve, no default-on scopes.
