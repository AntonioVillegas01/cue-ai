---
name: cue-codebase-map
description: Orientation for the cue Electron overlay — process boundaries, where each concern lives, and the invariants that must not be broken. Read this BEFORE editing main.js, preload.js, renderer/, or src/ when you don't already know the layout.
---

# cue codebase map

Electron overlay (~6.7k LOC, no build step, no framework, no bundler). `npm start` runs it directly.

## Three processes

| Process | Files | Owns |
|---|---|---|
| **main** | `main.js`, `src/*.js` | settings, API keys, network calls to model providers, screenshots, STT routing, global shortcuts, app-link server |
| **preload** | `preload.js` | the *entire* API surface the UI can reach (`window.cue`) |
| **renderer** | `renderer/*` | UI only. No node, no keys used directly, `contextIsolation: true` |

Audio is captured **in the renderer** (`getUserMedia` for mic, `getDisplayMedia` loopback for system audio) so it runs under cue's own Screen-Recording grant, then shipped to main as raw PCM over IPC (`mic:pcm` / `system:pcm`).

## Where things live

- `main.js` — the whole orchestration layer: window creation, capture toggle, `runFeature()` (the LLM entrypoint), all `ipcMain` handlers (from ~line 566), permissions gate, shortcuts.
- `src/llm.js` — every chat provider behind one `stream()` interface. `createLLM(settings)` → `{ ready, configurationError, stream }`.
- `src/stt.js` — batch transcription fallback chain (OpenAI → Groq → Gemini).
- `src/stt-streaming.js` — WebSocket STT (OpenAI Realtime, Deepgram Nova).
- `src/local-whisper-transcriber.js` + `src/whisper-server-session.js` — offline path: spawns `whisper-server` on 127.0.0.1 with a random URL path, feeds it segmented utterances. Nothing leaves the machine on this path.
- `src/whisper-model-manager.js` + `src/whisper-model-catalog.js` — model downloads, SHA-256 + size pinned.
- `src/prompts.js` — `MODES`: one entry per feature (`assist`, `say`, `followup`, `recap`, `ask`, `answerThis`, `leetcode`). Each has `needsScreen`, `buildSystem(contextBlock, aiRules)`, `build({transcript, userText})`.
- `src/interview-context.js` — detects question category from the transcript, injects only relevant profile fields.
- `src/store.js` — JSON settings file in `app.getPath('userData')/cue-data.json`. `DEFAULTS` is the schema.
- `src/applink.js` + `vendor/app-link/` — local Unix-socket/named-pipe server so an external assistant can ask cue about its state. **`vendor/app-link` is vendored; do not edit it here** (upstream: publik repo, `packages/app-link`).

## Invariants — breaking these is a bug, not a style choice

1. **`src/*.js` must not `require('electron')`** unless it genuinely needs it (`store.js`, `screen.js`, `applink.js` do). Everything else stays plain Node so `node --test` can exercise it without an Electron runtime.
2. **New IPC channels must be added to the `preload.js` allowlist** — the `on()` allowlist is an explicit array; an unlisted channel is silently dropped.
3. **`src/applink-state.js` sends counts, never content.** No transcript text, no résumé text, no API keys. That file is the privacy boundary for the app-link.
4. **Nothing may log an API key.** The ring buffer redacts known key shapes (`vendor/app-link/lib/ring-buffer.js`), but that is a net, not a licence.
5. **Renderer input is untrusted.** Anything arriving at `ipcMain` (settings patches, model ids, URLs, modes) gets validated in main.
6. **Local-Whisper mode never falls back to the cloud.** If the local path fails, the user is told, and audio is dropped — see the "No audio was sent to a cloud provider" messages in `main.js`.
7. **CI runs on Node 18/20/22.** No syntax or API newer than Node 18 in files CI `node --check`s.

## Gotchas

- The window deliberately titles itself `Microsoft Edge Update` and `app.setName('MicrosoftEdgeUpdate')` (`main.js` lifecycle section). Preserve or discuss deliberately; don't "fix" it silently.
- `setContentProtection` requires Windows build ≥ 19041; the check is `WIN_SUPPORTS_CONTENT_PROTECTION`.
- macOS needs the `MacLoopbackAudioForScreenShare` / `MacSckSystemAudioLoopbackOverride` switches appended **before** app ready, or the "them" channel silently never works.
- There are two `app.on('will-quit')` and two `window-all-closed` handlers at the bottom of `main.js`, plus a duplicate `ipcMain.on('app:quit')`. Consolidate if you touch that region.
