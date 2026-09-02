const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// store.js is the one src/ module that legitimately needs Electron (userData
// lives behind app.getPath). Stubbing it keeps the settings rules testable
// without an Electron runtime, the same way the provider tests stub the SDKs.
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-test-'));
const originalModuleLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => dataDirectory } };
  return originalModuleLoad.call(this, request, parent, isMain);
};

const store = require('../src/store');
const { MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, clampCodeFontSize } = store;

test.after(() => {
  Module._load = originalModuleLoad;
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

// ---- window geometry ------------------------------------------------------

test('a fresh install has no window position, and null does not decay to 0', () => {
  // Regression: coercing with Number() turns null into 0, which reads as a
  // real saved position and pins a first-run window to the corner instead of
  // centring it.
  const settings = store.getSettings();
  assert.equal(settings.windowX, null);
  assert.equal(settings.windowY, null);
  assert.equal(settings.windowW, null);
  assert.equal(settings.windowH, null);
});

test('persists window size alongside position', () => {
  const saved = store.setSettings({ windowX: 120, windowY: 40, windowW: 900, windowH: 760 });
  assert.equal(saved.windowW, 900);
  assert.equal(saved.windowH, 760);
  assert.equal(saved.windowX, 120);
  assert.equal(saved.windowY, 40);
});

test('a negative screen coordinate survives — a second monitor to the left is valid', () => {
  const saved = store.setSettings({ windowX: -1440, windowY: 0 });
  assert.equal(saved.windowX, -1440);
  assert.equal(saved.windowY, 0);
});

test('an unusable dimension degrades to unset rather than reaching BrowserWindow', () => {
  for (const bad of [0, -10, 'wide', null]) {
    const saved = store.setSettings({ windowW: bad });
    assert.equal(saved.windowW, null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('fractional geometry is rounded to whole pixels', () => {
  const saved = store.setSettings({ windowX: 10.6, windowW: 800.4 });
  assert.equal(saved.windowX, 11);
  assert.equal(saved.windowW, 800);
});

// ---- code font size -------------------------------------------------------

test('clamps the code font size into a readable range', () => {
  assert.equal(clampCodeFontSize(2), MIN_CODE_FONT_SIZE);
  assert.equal(clampCodeFontSize(400), MAX_CODE_FONT_SIZE);
  assert.equal(clampCodeFontSize(15), 15);
});

test('a non-numeric code font size falls back to the default', () => {
  assert.equal(clampCodeFontSize('huge'), 13);
  assert.equal(clampCodeFontSize(undefined), 13);
});

test('setSettings clamps the code font size it stores', () => {
  assert.equal(store.setSettings({ codeFontSize: 999 }).codeFontSize, MAX_CODE_FONT_SIZE);
  assert.equal(store.setSettings({ codeFontSize: 17 }).codeFontSize, 17);
});

// ---- base URL -------------------------------------------------------------

test('still rejects a bad Base URL typed into Settings', () => {
  // Unlike a stale value read off disk, a value the user just typed should
  // surface the error rather than being silently dropped.
  assert.throws(() => store.setSettings({ baseUrl: 'ftp://example.com' }), /HTTP or HTTPS/);
});
