const assert = require('node:assert/strict');
const test = require('node:test');
const { captureScreenshot, fitWithin, MAX_IMAGE_EDGE } = require('../src/screen');

function fakeImage({ empty = false, jpeg = Buffer.from('jpeg-bytes') } = {}) {
  return {
    isEmpty: () => empty,
    toJPEG: () => jpeg,
    toDataURL: () => 'data:image/png;base64,png-fallback'
  };
}

function fakeScreen({ cursorDisplay, primaryDisplay, throwOnCursor = false }) {
  return {
    getCursorScreenPoint() {
      if (throwOnCursor) throw new Error('no cursor');
      return { x: 10, y: 10 };
    },
    getDisplayNearestPoint: () => cursorDisplay,
    getPrimaryDisplay: () => primaryDisplay
  };
}

function fakeCapturer(sources, seen = {}) {
  return {
    getSources: async (options) => {
      seen.options = options;
      return sources;
    }
  };
}

const LAPTOP = { id: 1, size: { width: 1440, height: 900 }, scaleFactor: 2 };
const EXTERNAL = { id: 2, size: { width: 2560, height: 1440 }, scaleFactor: 1 };

// ---- fitWithin ------------------------------------------------------------

test('fitWithin: leaves an image that already fits alone', () => {
  assert.deepEqual(fitWithin(1200, 800, 1600), { width: 1200, height: 800, scaled: false });
});

test('fitWithin: scales the long edge down and keeps the aspect ratio', () => {
  const fitted = fitWithin(2880, 1800, 1600);
  assert.equal(fitted.width, 1600);
  assert.equal(fitted.height, 1000);
  assert.equal(fitted.scaled, true);
  assert.equal(Math.abs((2880 / 1800) - (fitted.width / fitted.height)) < 0.01, true);
});

test('fitWithin: handles a portrait display by scaling its height', () => {
  const fitted = fitWithin(1800, 2880, 1600);
  assert.equal(fitted.height, 1600);
  assert.equal(fitted.width, 1000);
});

test('fitWithin: never returns a zero dimension', () => {
  const fitted = fitWithin(4000, 3, 100);
  assert.equal(fitted.width, 100);
  assert.equal(fitted.height >= 1, true);
});

// ---- display selection ----------------------------------------------------
// The interview setup is the exercise on an external monitor and the call on
// the laptop, so "always the primary display" was routinely the wrong screen.

test('captures the display the cursor is on, not the primary one', async () => {
  const seen = {};
  const dataUrl = await captureScreenshot({
    screenApi: fakeScreen({ cursorDisplay: EXTERNAL, primaryDisplay: LAPTOP }),
    capturer: fakeCapturer([
      { display_id: '1', thumbnail: fakeImage({ jpeg: Buffer.from('laptop') }) },
      { display_id: '2', thumbnail: fakeImage({ jpeg: Buffer.from('external') }) }
    ], seen)
  });

  assert.equal(dataUrl, 'data:image/jpeg;base64,' + Buffer.from('external').toString('base64'));
  // Sized from the external display: 2560x1440 at scaleFactor 1 → long edge 1600.
  assert.equal(seen.options.thumbnailSize.width, 1600);
  assert.equal(seen.options.thumbnailSize.height, 900);
});

test('falls back to the primary display when the cursor position is unavailable', async () => {
  const seen = {};
  await captureScreenshot({
    screenApi: fakeScreen({ cursorDisplay: EXTERNAL, primaryDisplay: LAPTOP, throwOnCursor: true }),
    capturer: fakeCapturer([{ display_id: '1', thumbnail: fakeImage() }], seen)
  });
  // Laptop: 1440x900 at scaleFactor 2 → 2880x1800 native, capped to 1600.
  assert.equal(seen.options.thumbnailSize.width, 1600);
  assert.equal(seen.options.thumbnailSize.height, 1000);
});

test('uses the first source when no source matches the chosen display', async () => {
  const dataUrl = await captureScreenshot({
    screenApi: fakeScreen({ cursorDisplay: EXTERNAL, primaryDisplay: LAPTOP }),
    capturer: fakeCapturer([{ display_id: '99', thumbnail: fakeImage({ jpeg: Buffer.from('only') }) }])
  });
  assert.equal(dataUrl, 'data:image/jpeg;base64,' + Buffer.from('only').toString('base64'));
});

// ---- payload --------------------------------------------------------------
// A native-resolution PNG cost seconds before the first token, for pixels every
// vision model discards.

test('requests a capture no larger than the long-edge budget', async () => {
  const seen = {};
  await captureScreenshot({
    screenApi: fakeScreen({ cursorDisplay: EXTERNAL, primaryDisplay: LAPTOP }),
    capturer: fakeCapturer([{ display_id: '2', thumbnail: fakeImage() }], seen)
  });
  const { width, height } = seen.options.thumbnailSize;
  assert.equal(Math.max(width, height) <= MAX_IMAGE_EDGE, true);
});

test('does not upscale a display smaller than the budget', async () => {
  const seen = {};
  const small = { id: 3, size: { width: 1280, height: 800 }, scaleFactor: 1 };
  await captureScreenshot({
    screenApi: fakeScreen({ cursorDisplay: small, primaryDisplay: small }),
    capturer: fakeCapturer([{ display_id: '3', thumbnail: fakeImage() }], seen)
  });
  assert.deepEqual(seen.options.thumbnailSize, { width: 1280, height: 800, scaled: false });
});

test('falls back to the PNG data URL if JPEG encoding yields nothing', async () => {
  const dataUrl = await captureScreenshot({
    screenApi: fakeScreen({ cursorDisplay: LAPTOP, primaryDisplay: LAPTOP }),
    capturer: fakeCapturer([{ display_id: '1', thumbnail: fakeImage({ jpeg: Buffer.alloc(0) }) }])
  });
  assert.equal(dataUrl, 'data:image/png;base64,png-fallback');
});

test('returns null when there is no source or the image is empty', async () => {
  const screenApi = fakeScreen({ cursorDisplay: LAPTOP, primaryDisplay: LAPTOP });
  assert.equal(await captureScreenshot({ screenApi, capturer: fakeCapturer([]) }), null);
  assert.equal(
    await captureScreenshot({
      screenApi,
      capturer: fakeCapturer([{ display_id: '1', thumbnail: fakeImage({ empty: true }) }])
    }),
    null
  );
});
