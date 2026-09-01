---
name: cue-verify
description: Verify a cue change the way CI does, and write tests that run without Electron or a network. Use before reporting any code change in this repo as done, and whenever adding a test file under test/.
---

# Verifying a change in cue

There is no build step, no linter, and no type checker. CI is exactly two things — reproduce both locally before claiming a change works.

```bash
# 1. syntax gate (mirrors .github/workflows/ci.yml)
for f in main.js preload.js electron-builder.cjs renderer/*.js src/*.js scripts/*.js test/*.js; do node --check "$f"; done

# 2. the suite (node:test, ~130 tests, <1s)
npm test
```

CI runs the suite on **Node 18, 20 and 22**. Don't use syntax or stdlib APIs newer than Node 18 in files the gate checks.

Packaging is also verified on CI (`npm run pack:win`); run `npm run pack` locally only if you touched `electron-builder.cjs`, `scripts/after-pack.js`, or anything about what gets shipped — `test/build-config.test.js` already covers the config statically.

## Writing tests here

The suite is `node --test test/*.test.js`, plain `node:test` + `node:assert`. **No Electron, no network, no filesystem outside a temp dir.** That is why:

- Logic lives in `src/` modules, not inline in `main.js`. If you can't test it, it's in the wrong file.
- Modules take their I/O as injectable constructor options with real defaults:
  `WhisperModelManager({ userDataPath, fetchImpl, now })`,
  `WhisperServerSession({ fetchImpl, spawnImpl, findPort, wait, randomBytes })`,
  `LocalWhisperTranscriber({ sessionFactory, segmenterFactory })`.
  Follow that pattern for anything new that talks to the outside world.
- Pure-logic modules (`applink-state.js`, `openai-compatible.js`, `prompts.js`, `interview-context.js`, `vad.js`, `wav.js`) must not `require('electron')` at all.

Provider tests stub the SDK/fetch and assert on **behaviour that broke in production before**: model migration for retired ids, 404/429 error wording, the mac-signing release gate. Regression tests here are named after the failure, not the function.

## What "done" means

- [ ] both CI commands above pass locally, output shown
- [ ] a test that fails before the change and passes after, for any bug fix
- [ ] no new `require('electron')` in a `src/` module that didn't have one
- [ ] if the change touches the renderer/main boundary, the `preload.js` allowlist was checked (see `cue-ipc-channel`)
- [ ] if the change touches network, prompts, or logging, egress was reviewed (see `cue-privacy-egress-review`)

Tests passing is not proof the overlay works. For anything touching capture, window behaviour, shortcuts or the UI, say plainly that it was verified statically and needs a manual run — `npm start`, with `CUE_NO_PROTECT=1` if you need the window visible in a screen recording.
