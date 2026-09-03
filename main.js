const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createCaptureSession } = require('./src/capture-session');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM, DEFAULT_MODELS } = require('./src/llm');
const { MODES, CODE_MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { ConversationMemory } = require('./src/conversation');
const { clampWindowSize, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } = require('./src/window-geometry');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, refactor: false, tests: false, capture: false, solveCaptures: false, testCaptures: false, refactorCaptures: false, quit: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

let permWin = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
// What the model already said this session, so "now make it O(n)" has something
// to refer to. Scoped so coding help and interview help never mix — see src/conversation.js.
const conversation = new ConversationMemory();
// Screenshots staged for one scrolled coding challenge. Empty for the ordinary
// one-shot flow, which still captures at the moment the answer is asked for.
const captureSession = createCaptureSession();
// The last mode that actually produced an answer. `continue` borrows its system
// prompt, so a resumed LeetCode solution stays under the LeetCode rules.
let lastAnsweredMode = null;
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const FLUSH_MS = 900;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  // Size is restored as well as position. Reading a full solution needs a
  // taller panel than the default, and re-dragging the corner every session
  // was pure friction. Clamped to the work area so a display change — an
  // unplugged external monitor — can't restore a window bigger than the screen.
  const width = Math.min(Math.max(savedSettings.windowW || W, 380), workArea.width);
  const height = Math.min(Math.max(savedSettings.windowH || H, 260), workArea.height);

  let startX = Math.round(workArea.x + (workArea.width - width) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - width + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width,
    height,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    // The renderer's grip enforces these too, but a native floor means no code
    // path can leave the window smaller than its own controls.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it.
  // On Windows, WDA_EXCLUDEFROMCAPTURE requires build 19041+ (Windows 10 May 2020 Update).
  // On older builds we skip it silently to avoid a no-op and send a warning to the renderer.
  const shouldProtect = !process.env.CUE_NO_PROTECT;
  if (shouldProtect) {
    if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let boundsSaveTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const bounds = win.getBounds();
        store.setSettings({ windowX: bounds.x, windowY: bounds.y, windowW: bounds.width, windowH: bounds.height });
      }
    }, 500);
  };
  win.on('moved', saveBounds);
  // 'resized' is macOS/Windows only; 'resize' covers Linux. The debounce
  // collapses the double-fire on the platforms that emit both.
  win.on('resized', saveBounds);
  win.on('resize', saveBounds);

  // Cursor feedback while the window is being dragged by its pill.
  //
  // The renderer cannot detect this itself: an element with
  // `-webkit-app-region: drag` is handled by the OS and never receives the
  // mousedown, so `:active` never matches and no JS event fires. The move
  // events are the only signal that a drag is in progress.
  let dragIdleTimer = null;
  let dragging = false;
  const setDragging = (active) => {
    if (dragging === active) return;
    dragging = active;
    send('drag:state', { dragging: active });
  };
  win.on('move', () => {
    setDragging(true);
    // 'moved' is the reliable end signal on macOS/Windows, but it does not
    // exist everywhere — so a short idle timeout also releases the state.
    clearTimeout(dragIdleTimer);
    dragIdleTimer = setTimeout(() => setDragging(false), 200);
  });
  win.on('moved', () => {
    clearTimeout(dragIdleTimer);
    setDragging(false);
  });

  win.setTitle('Microsoft Edge Update'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Microsoft Edge Update');
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim() && res.text.trim().length > 1 && !/^[?!.,;:\-…]+$/.test(res.text.trim())) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      pushTranscript(turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startFlushLoop();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
    }
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  stopFlushLoop();
  stopStreamingSTT();
  buffers.you = []; buffers.them = [];
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- multi-capture session --------
// A coding exercise longer than the screen cannot be answered from one
// screenshot. The user scrolls and stages a capture at each position, then asks
// for the answer once. See src/capture-session.js for the staging rules and
// src/prompts.js `scrollNote` for how the overlap is reconciled.

// Show/hide the panel. Shares the ⌘⌥ family with the capture keys, and uses the
// down arrow because the gesture has a direction: the panel drops away and comes
// back, and the Hide button's chevron already points the same way.
//
// Note for anyone changing this: it is a *global* shortcut, so while cue runs it
// takes ⌥⌘↓ away from every other app — VS Code's "Add Cursor Below" among them.
const HIDE_ACCELERATOR = 'CommandOrControl+Alt+Down';
const CAPTURE_ACCELERATOR = 'CommandOrControl+Alt+C';
// What a staged session can be turned into. Both run an ordinary mode against
// the captures — `runFeature` already prefers the session over a fresh grab —
// so this pair is purely about giving the session two advertised exits instead
// of making the user remember that the single-shot keys also read it.
const SOLVE_CAPTURES_ACCELERATOR = 'CommandOrControl+Alt+P';
const TEST_CAPTURES_ACCELERATOR = 'CommandOrControl+Alt+T';
const REFACTOR_CAPTURES_ACCELERATOR = 'CommandOrControl+Alt+R';
// Human-readable forms for the status line, so the user is told the key they
// actually pressed rather than Electron's accelerator syntax.
const CAPTURE_KEYS = isMac ? '⌘⌥C' : 'Ctrl+Alt+C';
const SOLVE_KEYS = isMac ? '⌘⌥P' : 'Ctrl+Alt+P';
const TEST_KEYS = isMac ? '⌘⌥T' : 'Ctrl+Alt+T';
const REFACTOR_KEYS = isMac ? '⌘⌥R' : 'Ctrl+Alt+R';

// Escape is registered only while captures are staged. A *global* Escape held
// for the whole session would swallow the key in every other application —
// closing a dialog, leaving vim's insert mode — so it exists exactly as long as
// there is something for it to cancel.
let escapeRegistered = false;
function syncCaptureEscape() {
  const wanted = captureSession.count > 0;
  if (wanted === escapeRegistered) return;
  if (wanted) {
    escapeRegistered = globalShortcut.register('Escape', () => clearCaptureSession());
    if (!escapeRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds Escape', frame: 'syncCaptureEscape', context: { shortcut: 'cancelCaptures' } });
    }
  } else {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }
}

function screenCaptureMessage() {
  return process.platform === 'darwin'
    ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
    : process.platform === 'win32'
      ? 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.'
      : 'Screen capture failed. Check your desktop capture permissions, then try again.';
}

// Tells the renderer how many captures are staged so the panel can show a
// counter; the count is the whole payload — the images never leave main.
function sendCaptureState() {
  send('capture:shots', { count: captureSession.count, max: captureSession.max });
}

async function addCapture() {
  let shot = null;
  try {
    shot = await captureScreenshot();
    if (!shot) throw new Error('No screen source was available.');
  } catch (e) {
    recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'addCapture', context: { staged: captureSession.count } });
    send('status', { message: screenCaptureMessage() });
    return;
  }

  const result = captureSession.add(shot);
  if (!result.added) {
    const message = result.reason === 'full'
      ? `That is already ${captureSession.max} captures — the most cue sends at once. ` +
        `${SOLVE_KEYS} solve · ${TEST_KEYS} tests · ${REFACTOR_KEYS} refactor · Esc start over`
      : result.reason === 'duplicate'
        ? `Same screen as the last capture — still ${result.count}. Scroll first, then press ${CAPTURE_KEYS} again.`
        : 'That capture came back empty. Try again.';
    send('status', { message });
    return;
  }

  sendCaptureState();
  syncCaptureEscape();
  // A delimited list rather than a sentence: with four exits the prose form ran
  // past the width of the status line and buried the last option.
  send('status', {
    message: `Capture ${result.count} saved. Scroll, then ${CAPTURE_KEYS} add · ` +
      `${SOLVE_KEYS} solve · ${TEST_KEYS} tests · ${REFACTOR_KEYS} refactor · Esc discard`
  });
}

function clearCaptureSession(options = {}) {
  if (!captureSession.clear()) return false;
  sendCaptureState();
  syncCaptureEscape();
  if (!options.quiet) send('status', { message: 'Captures discarded.' });
  return true;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = CODE_MODES.has(mode) ? null : detectCategory(transcript);
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    // Staged captures win over a fresh grab: if the user scrolled through a long
    // problem to collect them, capturing the screen again would answer about
    // whatever happens to be visible now — the bottom of the problem — and
    // silently throw the rest away.
    let images = [];
    if (def.needsScreen) {
      if (captureSession.count) {
        images = captureSession.list();
      } else {
        try {
          const shot = await captureScreenshot();
          if (!shot) throw new Error('No screen source was available.');
          images = [shot];
        }
        catch (e) {
          recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
          send('status', { message: screenCaptureMessage() });
        }
      }
    }

    const settingsForPrompt = store.getSettings();
    // `continue` has no voice of its own: it resumes the answer that was cut
    // off, so it runs under the prompt — and the context rules — of whatever
    // mode produced that answer.
    const systemMode = (def.inheritSystemFromLastMode && MODES[lastAnsweredMode]) ? lastAnsweredMode : mode;
    const systemDef = MODES[systemMode];
    const contextBlock = buildInterviewContext(settingsForPrompt, systemMode, transcript);
    const system = systemDef.buildSystem ? systemDef.buildSystem(contextBlock, settingsForPrompt.aiRules || '') : (systemDef.system || '');
    const built = def.build({ transcript, userText: userText || '', shots: images.length });
    const priorTurns = conversation.enter(def.memoryScope || 'interview');

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm();
    });
    // A provider that stops on its token ceiling returns a half-written answer
    // that looks exactly like a finished one — the worst case being a code
    // block cut off mid-line during a live exercise. The UI offers "Continue".
    let truncated = false;
    const streamParams = {
      system,
      turns: [...priorTurns, { role: 'user', text: built }],
      imageDataUrls: images,
      onToken: (t) => { if (streamSettled) return; rearm(); send('llm:token', { text: t }); },
      onTruncated: () => { truncated = true; }
    };
    // Modes that need room for a whole program say so; everything else keeps
    // the conversational default from the provider tier.
    if (def.maxTokens) {
      streamParams.maxTokens = settingsForPrompt.smart ? def.maxTokens.smart : def.maxTokens.fast;
    }

    let answer = '';
    try {
      answer = await Promise.race([llm.stream(streamParams), stalled]);
    } finally {
      streamSettled = true;
      clearTimeout(watchdog);
    }
    // Recorded only on success, and only as a complete pair, so the turn list
    // stays strictly alternating for providers that require it.
    conversation.record(built, answer);
    lastAnsweredMode = systemMode;
    // The staged captures have been answered, so the session is spent. Cleared
    // only on success: if the provider errored, the user retries the same key
    // rather than scrolling the whole problem again.
    if (images.length) clearCaptureSession({ quiet: true });
    send('llm:done', { truncated, exchanges: conversation.exchanges });
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
// Multi-capture session. `capture:add` exists so the panel can offer the same
// action as the shortcut when another app has taken the key.
ipcMain.handle('capture:add', async () => { await addCapture(); return captureSession.count; });
ipcMain.handle('capture:clear', () => { clearCaptureSession(); return captureSession.count; });
ipcMain.handle('capture:shots', () => ({ count: captureSession.count, max: captureSession.max }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
// The model cue falls back to per provider. Sent to the renderer so the model
// fields can show the real default as a placeholder instead of a blank box —
// an empty field means "use this", not "broken".
ipcMain.handle('provider:defaults', () => DEFAULT_MODELS);
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  // Clearing the conversation too: the recorded turns quote the transcript, so
  // leaving them behind would keep answering from words the user just erased.
  conversation.clear();
  lastAnsweredMode = null;
  return { ok: true };
});
// "Start fresh" — drops the follow-up context without touching the transcript.
ipcMain.handle('context:clear', () => {
  conversation.clear();
  lastAnsweredMode = null;
  return { ok: true, exchanges: conversation.exchanges };
});
// The renderer runs on file:// where the async clipboard API is unreliable, and
// copying a solution has to work on the first click. Length-capped because the
// argument comes from the renderer.
const MAX_CLIPBOARD_CHARS = 100000;
ipcMain.on('clipboard:write', (_e, text) => {
  const value = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!value) return;
  clipboard.writeText(value.slice(0, MAX_CLIPBOARD_CHARS));
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
// Resize driven by the panel's grip.
//
// The window's own resize edges are unreachable in an overlay: the renderer
// makes every empty pixel click-through, and those empty pixels are exactly
// where the edges are. So the grip does the work, and this clamps whatever
// pointer arithmetic it sends.
ipcMain.on('window:resize', (_e, size) => {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const next = clampWindowSize(size, workArea, { width: bounds.width, height: bounds.height });
  if (next.width === bounds.width && next.height === bounds.height) return;
  win.setSize(next.width, next.height);
});
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.on('app:quit', () => app.quit());
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.assist = globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  shortcutState.say = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('say', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  // Note: this is a *global* shortcut, so while cue is running it takes
  // Cmd/Ctrl+R away from every other app — browser reload included.
  shortcutState.refactor = globalShortcut.register('CommandOrControl+R', () => runFeature('refactor', ''));
  // Same caveat as the line above: a *global* shortcut, so while cue runs it
  // takes Cmd/Ctrl+T away from every other app — "new tab" included.
  shortcutState.tests = globalShortcut.register('CommandOrControl+T', () => runFeature('tests', ''));
  // Multi-capture: stage a screenshot per scroll position, then solve them as
  // one problem. Escape is registered on demand — see syncCaptureEscape.
  shortcutState.capture = globalShortcut.register(CAPTURE_ACCELERATOR, () => { addCapture(); });
  shortcutState.solveCaptures = globalShortcut.register(SOLVE_CAPTURES_ACCELERATOR, () => runFeature('leetcode', ''));
  shortcutState.testCaptures = globalShortcut.register(TEST_CAPTURES_ACCELERATOR, () => runFeature('tests', ''));
  shortcutState.refactorCaptures = globalShortcut.register(REFACTOR_CAPTURES_ACCELERATOR, () => runFeature('refactor', ''));
  // Collapse the panel to the toolbar and back. This was CommandOrControl+Shift+/
  // — which on macOS is the system Help shortcut (⌘⇧/ is how ⌘? is typed), so it
  // was fighting the OS for the key on the one platform it mattered on. It also
  // sat in no obvious family, and nothing in the UI announced it, so the feature
  // existed and went unused. ⌘⌥A joins the ⌘⌥ family the capture keys already
  // established, and the Hide button now carries the hint.
  shortcutState.hide = globalShortcut.register(HIDE_ACCELERATOR, () => send('hide:toggle', {}));
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  if (process.platform !== 'darwin') return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: await verifyScreenAccess(),
  };
}

async function requestPermissions() {
  if (process.platform !== 'darwin') return true;

  // Trigger the macOS microphone permission dialog (first-use only)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Trigger the macOS screen-recording permission dialog (first-use only).
  // There is no askForMediaAccess('screen'), but attempting to enumerate
  // sources via desktopCapturer will cause macOS to prompt the user.
  const screenStatus = await verifyScreenAccess();
  if (screenStatus !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
  }

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (isMac && app.dock) app.dock.hide();

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      const request = { video: sources[0] };
      if (isWindows) request.audio = true;
      else request.audio = 'loopback';
      callback(request);
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  app.setName('MicrosoftEdgeUpdate');
  if (isWindows) {
    process.title = 'MicrosoftEdgeUpdate';
  }

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
