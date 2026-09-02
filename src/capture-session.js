// Multi-capture session — the staged screenshots of ONE coding challenge.
//
// A long exercise does not fit on a screen. The user scrolls, presses the
// capture shortcut at each position, and cue holds the images until they ask
// for the answer. Everything here is deliberately plain data so the rules can
// be tested without Electron: the actual screen grab lives in src/screen.js and
// the shortcuts in main.js.
//
// Two rules are worth stating because they are the ones that bite:
//
//   • **A cap.** Every staged shot is a full image in the request body. Eight
//     captures of a 1600px-long-edge JPEG is already a large payload and a slow
//     first token; past that the user is not capturing a problem, they are
//     capturing a document, and the honest answer is to say so.
//   • **No consecutive duplicates.** Pressing the shortcut twice without
//     scrolling is the common accident. The second image is byte-identical, and
//     sending it costs tokens and latency to tell the model something it was
//     already told. Only the *immediately previous* shot is compared: scrolling
//     back to an earlier position on purpose is a legitimate capture.

const MAX_SHOTS = 8;

/**
 * @param {{ max?: number }} [options]
 * @returns a session whose `add` reports why a capture was refused, so the
 *          caller can show the user something specific instead of "failed".
 */
function createCaptureSession(options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : MAX_SHOTS;
  const shots = [];

  return {
    get count() { return shots.length; },
    get max() { return max; },

    /** @returns {{ added: boolean, reason: string, count: number }} */
    add(dataUrl) {
      const image = typeof dataUrl === 'string' ? dataUrl : '';
      if (!image) return { added: false, reason: 'empty', count: shots.length };
      if (shots.length >= max) return { added: false, reason: 'full', count: shots.length };
      if (shots.length && shots[shots.length - 1] === image) {
        return { added: false, reason: 'duplicate', count: shots.length };
      }
      shots.push(image);
      return { added: true, reason: 'added', count: shots.length };
    },

    /** A copy — callers hand this straight to the LLM layer and must not alias it. */
    list() { return shots.slice(); },

    /** @returns true when there was something to clear, so the caller can stay quiet otherwise. */
    clear() {
      if (!shots.length) return false;
      shots.length = 0;
      return true;
    }
  };
}

module.exports = { createCaptureSession, MAX_SHOTS };
