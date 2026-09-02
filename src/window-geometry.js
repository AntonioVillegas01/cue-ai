// Window sizing rules, kept out of main.js so they can be tested without Electron.
//
// The resize grip is driven from the renderer, which means the requested size
// is untrusted input: it arrives as whatever the pointer maths produced,
// including NaN from a dropped pointer event or a number large enough to put
// the panel off every display.

// Below this the panel stops being usable: the composer and action row no
// longer fit, and the answer pane collapses to nothing.
//
// The height floor is not a guess. Measured at 420x380 the panel overflowed the
// window by 58px, which pushed the resize grip itself off the bottom edge —
// shrink that far and there is nothing left to grab to grow back.
//
// 460 is the first height that clears it at the *narrowest* allowed width,
// where the action row wraps to four lines and so eats the most vertical
// space. Re-measure with the layout harness if that row ever changes.
const MIN_WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 460;

/**
 * Clamp a requested window size to something sane for the display it is on.
 *
 * @param {{width:unknown, height:unknown}} requested Size asked for by the renderer.
 * @param {{width:number, height:number}} workArea The display's usable area.
 * @param {{width:number, height:number}} current Fallback when a value is unusable.
 * @returns {{width:number, height:number}}
 */
function clampWindowSize(requested, workArea, current) {
  // `null`/`undefined`/`''` are checked before coercing: Number(null) is 0,
  // which is finite, so a naive check would clamp a missing value down to the
  // minimum window size instead of leaving the window alone.
  const pick = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? number : fallback;
  };

  const maxWidth = Math.max(MIN_WINDOW_WIDTH, workArea.width);
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, workArea.height);

  return {
    width: Math.min(Math.max(pick(requested && requested.width, current.width), MIN_WINDOW_WIDTH), maxWidth),
    height: Math.min(Math.max(pick(requested && requested.height, current.height), MIN_WINDOW_HEIGHT), maxHeight)
  };
}

module.exports = { clampWindowSize, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT };
