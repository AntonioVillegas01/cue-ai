const assert = require('node:assert/strict');
const test = require('node:test');
const { clampWindowSize, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } = require('../src/window-geometry');

const WORK_AREA = { width: 1920, height: 1080 };
const CURRENT = { width: 700, height: 600 };

test('passes a reasonable size through untouched', () => {
  assert.deepEqual(clampWindowSize({ width: 900, height: 760 }, WORK_AREA, CURRENT), { width: 900, height: 760 });
});

test('refuses to shrink below a usable panel', () => {
  const size = clampWindowSize({ width: 40, height: 20 }, WORK_AREA, CURRENT);
  assert.deepEqual(size, { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
});

test('never grows past the display', () => {
  const size = clampWindowSize({ width: 99999, height: 99999 }, WORK_AREA, CURRENT);
  assert.deepEqual(size, { width: 1920, height: 1080 });
});

test('a dropped pointer event keeps the current size rather than collapsing the window', () => {
  // The grip computes `start + delta`; one NaN coordinate must not resize.
  for (const bad of [NaN, undefined, null, 'wide', {}]) {
    assert.deepEqual(
      clampWindowSize({ width: bad, height: bad }, WORK_AREA, CURRENT),
      CURRENT,
      `expected the current size for ${String(bad)}`
    );
  }
});

test('clamps each axis independently', () => {
  const size = clampWindowSize({ width: 10, height: 800 }, WORK_AREA, CURRENT);
  assert.equal(size.width, MIN_WINDOW_WIDTH);
  assert.equal(size.height, 800);
});

test('rounds fractional pointer maths to whole pixels', () => {
  assert.deepEqual(clampWindowSize({ width: 812.6, height: 640.2 }, WORK_AREA, CURRENT), { width: 813, height: 640 });
});

test('a display smaller than the minimum still yields the minimum', () => {
  // A tiny external display must not produce a zero-sized window.
  const size = clampWindowSize({ width: 700, height: 600 }, { width: 320, height: 240 }, CURRENT);
  assert.deepEqual(size, { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
});

test('the height floor keeps the resize grip on screen', () => {
  // Measured: the panel chrome is 316px and the answer pane has a 120px floor,
  // so anything under 436px pushes the grip past the bottom edge — and the grip
  // is the only way to resize an overlay whose real edges are click-through.
  // Shrinking below that is a one-way trip.
  assert.ok(
    MIN_WINDOW_HEIGHT >= 436,
    `MIN_WINDOW_HEIGHT ${MIN_WINDOW_HEIGHT} would put the resize grip off screen`
  );
});

test('a resize request below the floor lands exactly on it, not somewhere unusable', () => {
  const size = clampWindowSize({ width: -100, height: -100 }, WORK_AREA, CURRENT);
  assert.equal(size.width, MIN_WINDOW_WIDTH);
  assert.equal(size.height, MIN_WINDOW_HEIGHT);
});
