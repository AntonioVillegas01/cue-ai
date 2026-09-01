---
name: cue-llm-provider
description: Add or modify an AI provider (chat/LLM) or STT provider in cue. Use when touching src/llm.js, src/stt.js, src/stt-streaming.js, model defaults, or the provider picker — the wiring spans five files and a missed one leaves the provider unselectable or silently unconfigured.
---

# Adding a provider to cue

cue is bring-your-own-key. A provider is "done" only when all five touchpoints agree.

## Chat / LLM provider

1. **`src/llm.js`**
   - Write `streamX({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken })` → returns the full text, calls `onToken(delta)` per chunk.
   - If the API is OpenAI-compatible, do **not** write a new function — route through `streamOpenAI` with a `baseURL` (see how `groq` and `minimax` do it in the `stream()` switch).
   - Add the id to `DEFAULT_MODELS`.
   - Add a `PROVIDER_LABELS` entry if the display name isn't just capitalised.
   - Wire the dispatch inside `createLLM(...).stream()`.
   - Config errors go through `configurationError` (a string the UI shows), never a thrown error at construction time.
2. **`src/store.js`** — add the key slot in `DEFAULTS.apiKeys` and a `DEFAULTS.models.<provider> = { fast, smart }` pair. Users' existing files are deep-merged over DEFAULTS, so a new field appears automatically for them.
3. **`renderer/index.html`** — a button in `#provider-seg` with `data-provider="<id>"`, and a `#key-<id>` input (`type="password"`, `autocomplete="off"`).
4. **`renderer/renderer.js`** — read it in the settings-load block (~line 1259) and write it in the save block (~line 1534). Both lists are manual.
5. **`test/llm.test.js`** — cover model selection and error mapping.

### Error mapping is shared — don't duplicate it
`formatProviderErrorMessage`, `isQuotaError`, `isNotFoundError` in `src/llm.js` are also used by `src/stt.js`, so a 429 or a 404 reads identically whether it came from chat or transcription. Extend those helpers rather than adding provider-specific error text at the call site.

### Retired models
Providers retire model ids and every request then 404s for users whose settings file pins the dead id. `DEAD_GEMINI_MODEL_RE` + the migration inside `createLLM` is the pattern: migrate at read time, not just in `DEFAULTS`, or existing users keep hitting it forever.

## STT provider

- **Batch** (`src/stt.js`): push into the `chain` in `createSTT`, guarded by `selectedProvider === 'auto' || selectedProvider === '<id>'` and the key being present. Order matters — the chain is the fallback order.
- **Streaming** (`src/stt-streaming.js`): a class with `connect()`, `sendAudio(pcm)`, `disconnect()` and the `onTranscript / onInterim / onError / onStatusChange` callbacks. Input is 16 kHz mono PCM16.
- **Credentials go in headers, never in the query string.** Both existing WebSocket clients pass `Authorization` as a header (`Bearer` for OpenAI, `Token` for Deepgram) — a key in a URL ends up in proxy and provider access logs.
- A streaming failure must fall back to batch, or say plainly that it can't (`initStreamingSTT`'s `onError` in `main.js`).
- **Never add a cloud fallback to the local-Whisper path.** `sttProvider === 'local'` is a promise to the user that audio stays on the machine.

## Before finishing
Run `npm test`. Then state in your summary **which endpoint the new provider talks to and what payload it sends** — screenshots and meeting transcripts are the payload here, so a new provider is a new data-egress destination (see the `cue-privacy-egress-review` skill).
