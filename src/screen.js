// Screenshot for the vision models (main process).
// The first call can trigger the system permission prompt for the app.
//
// Two decisions live here and both are about the coding-challenge flow:
//
//   • **Which screen.** This used to always capture the primary display. The
//     common interview setup is the exercise on an external monitor and the
//     call on the laptop, so "primary" was routinely the wrong screen and cue
//     answered about whatever happened to be on it. The display under the
//     cursor is where the user is working, by definition.
//   • **How big.** A retina display captured at native resolution is a
//     multi-megabyte PNG, and every vision model resizes it down anyway
//     (Anthropic documents ~1568px on the long edge; OpenAI tiles at 512).
//     Sending the full thing bought nothing and cost seconds before the first
//     token. desktopCapturer scales during capture, so this is free.

// Long edge of the image actually sent. Sits just above what the providers
// downscale to, so text stays crisp without paying for discarded pixels.
const MAX_IMAGE_EDGE = 1600;
// Text screenshots are what this reads, so quality stays high — the win comes
// from the resize, not from crushing the code into JPEG artifacts.
const JPEG_QUALITY = 90;

/** Proportional fit inside a square of `maxEdge`. Never upscales. */
function fitWithin(width, height, maxEdge) {
  const w = Math.max(1, Math.round(width || 0));
  const h = Math.max(1, Math.round(height || 0));
  const longest = Math.max(w, h);
  if (!Number.isFinite(maxEdge) || maxEdge <= 0 || longest <= maxEdge) {
    return { width: w, height: h, scaled: false };
  }
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true
  };
}

/**
 * The display the user is actually looking at. Falls back to the primary
 * display if the cursor position is unavailable for any reason — a wrong
 * screenshot beats no screenshot.
 */
function pickDisplay(screenApi) {
  try {
    const point = screenApi.getCursorScreenPoint();
    const display = screenApi.getDisplayNearestPoint(point);
    if (display) return display;
  } catch (_) { /* fall through to primary */ }
  return screenApi.getPrimaryDisplay();
}

async function captureScreenshot(options = {}) {
  const { maxEdge = MAX_IMAGE_EDGE, quality = JPEG_QUALITY } = options;
  let { screenApi, capturer } = options;
  if (!screenApi || !capturer) {
    const electron = require('electron');
    screenApi = screenApi || electron.screen;
    capturer = capturer || electron.desktopCapturer;
  }

  const target = pickDisplay(screenApi);
  const { width, height } = target.size;
  const scale = target.scaleFactor || 1;
  const thumbnailSize = fitWithin(width * scale, height * scale, maxEdge);

  const sources = await capturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) return null;
  const source = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0];
  const image = source.thumbnail;
  if (!image || image.isEmpty()) return null;

  // JPEG rather than PNG: same legibility for a screenshot at this size, a
  // fraction of the bytes, and the payload is base64 in the request body.
  const jpeg = image.toJPEG(quality);
  if (!jpeg || !jpeg.length) return image.toDataURL();
  return 'data:image/jpeg;base64,' + jpeg.toString('base64');
}

module.exports = { captureScreenshot, fitWithin, pickDisplay, MAX_IMAGE_EDGE, JPEG_QUALITY };
