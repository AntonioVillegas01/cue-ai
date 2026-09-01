---
name: cue-audio-pipeline
description: Work on or debug cue's audio path — mic/system capture, VAD, transcription modes (streaming, batch, local Whisper), or a "it says it's listening but nothing appears" report. Use before touching renderer audio worklets, src/vad.js, src/stt*.js, src/utterance-segmenter.js, or routeAudio in main.js.
---

# cue's audio pipeline

## The path, end to end

```
renderer: getUserMedia (mic)            ──┐
          getDisplayMedia loopback (them)─┤ AudioWorklet → PCM16 @16kHz mono
                                          │   renderer/audio-worklet-processor.js
                                          │   renderer/pcm-processor.js
                                          ▼
                   IPC 'mic:pcm' / 'system:pcm'  (ArrayBuffer)
                                          ▼
                   main.js routeAudio(channel, buf)
                                          ▼
        ┌─────────────────┬───────────────────────┬──────────────────────┐
        │ local           │ streaming             │ batch                │
        │ LocalWhisper-   │ streamingSTT[channel] │ buffers[channel] →   │
        │ Transcriber     │ .sendAudio()          │ flushChannel() /900ms│
        └─────────────────┴───────────────────────┴──────────────────────┘
                                          ▼
        transcript[] (capped 200 turns) → 'transcript' / 'stt:final' → UI
```

Two channels throughout: **`you`** (mic) and **`them`** (system/meeting audio). They are never mixed.

## Mode selection (`setCapturing` in main.js)

1. `sttProvider === 'local'` → `startLocalWhisper`. Fails loudly, **never** falls back to cloud.
2. Otherwise `initStreamingSTT()` — succeeds if a Deepgram or OpenAI key is present.
3. Otherwise `startFlushLoop()` — batch, via the `createSTT` fallback chain.

## Audio format facts

- 16 kHz, mono, signed 16-bit LE everywhere internally (`src/wav.js` wraps it for the batch APIs).
- OpenAI Realtime is configured at 24 kHz in `stt-streaming.js`; Deepgram at 16 kHz. If you change the capture rate, both configs and the VAD thresholds move with it.
- Batch flush drops anything under `MIN_BYTES` (~0.12 s) or below `RMS_GATE` (180).

## VAD and segmentation

- `src/vad.js` — `AdaptiveVAD` (onset/offset thresholds, `silenceFrames`) drives the speaking indicator; `AudioRingBuffer` keeps 300 ms of pre-speech so word onsets aren't clipped.
- `them` uses more forgiving thresholds than `you` (remote audio is quieter and compressed) — thresholds appear in **two** places: `main.js`'s `vad` object and `LocalWhisperTranscriber.start()`. Change both.
- `src/utterance-segmenter.js` cuts utterances for the local path only.

## Debugging "it says listening but no text"

Work down this list; each step distinguishes a different failure:

1. **`sttDisabled`?** One rejected key or quota error latches it `true` and stops all retries until settings change or capture restarts (`handleSttError`). The UI status message says which provider.
2. **Which mode actually started?** `[cue] capture started, mode: local|streaming|batch` on stdout, and the `capture:state` event carries it.
3. **Is PCM arriving?** `routeAudio` only runs while `state.capturing`; the `mic:pcm`/`system:pcm` handlers drop everything otherwise.
4. **Silence gate.** Batch mode discards below `RMS_GATE` — a quiet mic looks identical to a broken one.
5. **`them` channel silent on macOS?** Needs macOS 14.4+ and the two Chromium switches at the top of `main.js`. Below that, `you` works and `them` never will.
6. **Hallucination filter.** `looksLikeHallucination` in `src/stt.js` drops "thank you", "bye", emoji-only, etc. Whisper emits these on silence; if real speech is vanishing, check this list first.
7. **Local mode:** the whisper-server child logs into `logTail` (`src/whisper-server-session.js`) and surfaces via `onError`. Model must pass SHA-256 verification at start.

## Testing
`test/vad*`, `test/utterance-segmenter.test.js`, `test/stt*.test.js`, `test/local-whisper-transcriber.test.js`, `test/whisper-server-session.test.js` all run without Electron and without a network — `WhisperServerSession` takes `fetchImpl`, `spawnImpl`, `findPort`, `wait` and `randomBytes` as injectable deps. Keep new audio logic in `src/` with the same shape so it stays testable.
