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

// Window geometry arrives from a JSON file on disk, so a non-numeric value has
// to degrade to "unset" rather than reach BrowserWindow.
//
// `null` is the documented "never positioned" value and must survive as null:
// Number(null) is 0, so a naive coercion would silently turn a fresh install
// into a window pinned to the top-left corner instead of a centred one.
function normalizeCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? number : null;
}

function normalizeDimension(value) {
  const number = normalizeCoordinate(value);
  return number !== null && number > 0 ? number : null;
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
  // Anthropic workspace id. Required only for identity-linked API keys, which
  // reject every request with a 400 until the `anthropic-workspace-id` header
  // names the workspace the call acts in. Empty for an ordinary key, and the
  // header is then omitted entirely rather than sent blank.
  anthropicWorkspaceId: '',
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
// This one value leaves the process as an HTTP *header*, not as a body field,
// and it arrives from the renderer — which the codebase treats as untrusted.
// A stray newline would either break the request or, on a less careful client,
// append a header of the attacker's choosing, so the value is reduced to the
// characters an id can actually contain rather than merely trimmed.
const MAX_WORKSPACE_ID_CHARS = 128;
function normalizeWorkspaceId(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_WORKSPACE_ID_CHARS);
}

function normalize(settings) {
  settings.baseUrl = normalizeBaseUrl(settings.baseUrl);
  settings.anthropicWorkspaceId = normalizeWorkspaceId(settings.anthropicWorkspaceId);
  settings.codeFontSize = clampCodeFontSize(settings.codeFontSize);
  settings.windowX = normalizeCoordinate(settings.windowX);
  settings.windowY = normalizeCoordinate(settings.windowY);
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
  MAX_WORKSPACE_ID_CHARS,
  normalizeWorkspaceId,
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
