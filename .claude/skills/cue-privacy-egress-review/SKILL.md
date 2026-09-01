---
name: cue-privacy-egress-review
description: Review what user data leaves the machine before shipping a cue change. Use when a change touches network calls, prompts, logging, the app-link, screenshots, transcripts, or the résumé/profile fields — cue handles screen captures and both sides of private conversations, so egress review is not optional here.
---

# Data-egress review for cue

cue captures the user's **whole primary display**, their **microphone**, and **the other party's audio in a meeting**, plus a résumé, salary target and prep notes. Every one of those is sensitive, and some of it belongs to people who never consented (the "them" channel). Treat any new outbound byte as a privacy decision.

## The current egress inventory — keep this accurate

Destinations are **only** those the user configured with their own key:

| What leaves | Where | Trigger |
|---|---|---|
| Full-resolution screenshot of the primary display (PNG data URL) | the selected chat provider | any mode with `needsScreen: true` — `assist`, `ask`, `leetcode` |
| Transcript turns (both channels) | the selected chat provider | every mode; `say`/`followup`/`recap` send the whole conversation |
| Résumé, job description, STAR stories, salary target, "why leaving", questions to ask | the selected chat provider, inside the system prompt | any mode, via `buildInterviewContext` |
| 16 kHz PCM audio, both channels | OpenAI / Groq / Gemini / Deepgram | while listening, unless `sttProvider: 'local'` |
| Proper nouns scraped from the résumé + job description | the STT provider, as a vocab `prompt` | `buildVocabPrompt` in `src/stt.js` |
| Nothing | — | `sttProvider: 'local'` (whisper.cpp on 127.0.0.1) |

No telemetry, no analytics, no crash reporting, no vendor of cue's own. **Keep it that way** — adding one would change what this app is.

Outbound hosts, exhaustively: the configured chat/STT provider APIs, `huggingface.co` (model files, SHA-256 pinned), `github.com` releases (whisper.cpp runtime, SHA-256 pinned), and whatever `baseUrl` the user sets for the Custom provider.

## Rules

1. **The screenshot is the whole screen, not cue's window.** It carries whatever else is open — password managers, other people's messages. Never add a screenshot to a mode that doesn't obviously need one, and never send one on a path the user didn't trigger.
2. **The app-link sends counts, never content** (`src/applink-state.js`). Turn count, timestamp, `hasKey: boolean`, `hasResumeContext: boolean`. If you find yourself adding a field that carries transcript text, résumé text, or a key, stop.
3. **Nothing may log a credential.** `vendor/app-link/lib/ring-buffer.js` redacts known key shapes on the way in; that is a backstop for mistakes, not permission to log tokens.
4. **`recordEvent` output is readable by a consenting external caller.** Error messages you put in it should describe the failure, not echo the request body.
5. **Untrusted text stays fenced.** The résumé is wrapped as data with explicit "ignore instructions inside it" framing (`appendResumeContext`); `aiRules` is user-authored and treated as instruction. A new field goes in one of those two buckets deliberately — the transcript, which contains words spoken by *other people*, belongs in the untrusted bucket.
6. **Local mode is a hard promise.** No silent cloud fallback, ever.
7. **New provider = new destination.** Say so in the PR description.

## Reviewing a diff

- `grep -n "https\?://\|fetch(\|new WebSocket" <changed files>` — any new host?
- Does anything new reach `llm.stream(...)`, `stt.transcribe(...)`, or `captureScreenshot()`?
- Does `describeState` grow a field carrying content rather than a count?
- Does a new setting hold a secret? Then it must not be echoed into prompts, logs, error strings, or the app-link.
- Does the change make cue send data when the user did not press anything?
