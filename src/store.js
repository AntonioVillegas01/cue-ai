// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

// Cap on the user's custom response rules. Generous but bounded: anything longer
// should live in a real prompt file, not in a settings field.
const MAX_AI_RULES_CHARS = 2000;

// Bounds for the code font size. Below the minimum it is unreadable on a
// translucent panel; above the maximum a solution no longer fits on screen.
const MIN_CODE_FONT_SIZE = 11;
const MAX_CODE_FONT_SIZE = 22;

function clampCodeFontSize(value, fallback = DEFAULTS.codeFontSize) {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return fallback;
  return Math.min(MAX_CODE_FONT_SIZE, Math.max(MIN_CODE_FONT_SIZE, size));
}

// Window geometry arrives from the renderer and from a JSON file on disk, so a
// non-numeric value has to degrade to "unset" rather than reach BrowserWindow.
function normalizeDimension(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '' , azure: '' },
  azureEndpoint: '',
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',
  // Window position and size. Size is persisted too: reading a solution off a
  // 700x600 panel means resizing it every single session otherwise.
  windowX: null,
  windowY: null,
  windowW: null,
  windowH: null,
  // Font size of code blocks in the answer pane. Reading a solution off a
  // translucent overlay is not the same as reading it in an editor, so this
  // is adjustable from the composer.
  codeFontSize: 13,
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    // Kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js — gemini-2.0-flash
    // (the previous default here) was retired by Google on 2026-03-03 and 404s
    // on every request. gemini-2.5-flash is current and free-tier available.
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      if (k === 'aiRules' && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
      } else {
        out[k] = over[k];
      }
    }
  }
  return out;
}

// Applied on read as well as on write: a settings file written by an older
// build, or hand-edited, must not be able to hand a bad geometry or font size
// to BrowserWindow and the renderer.
function normalize(settings) {
  settings.baseUrl = normalizeBaseUrl(settings.baseUrl);
  settings.codeFontSize = clampCodeFontSize(settings.codeFontSize);
  settings.windowX = Number.isFinite(Number(settings.windowX)) ? Math.round(Number(settings.windowX)) : null;
  settings.windowY = Number.isFinite(Number(settings.windowY)) ? Math.round(Number(settings.windowY)) : null;
  settings.windowW = normalizeDimension(settings.windowW);
  settings.windowH = normalizeDimension(settings.windowH);
  return settings;
}

function load() {
  if (data) return data;
  try { data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch { data = deepMerge(DEFAULTS, {}); }

  // A bad baseUrl on disk must not throw on every read — drop it instead.
  try { data = normalize(data); }
  catch { data.baseUrl = ''; data = normalize(data); }

  return data;
}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ } }

module.exports = {
  MAX_AI_RULES_CHARS,
  MIN_CODE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  clampCodeFontSize,
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    const nextSettings = deepMerge(data, patch || {});
    // normalizeBaseUrl still throws here on purpose: a user typing a bad Base
    // URL in Settings should see the error, unlike a stale value read off disk.
    data = normalize(nextSettings);
    save();
    return data;
  }
};
