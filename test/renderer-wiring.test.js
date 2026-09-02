const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// The renderer is the one part of cue with no runtime test coverage: it needs a
// browser, and its failure mode is silent and total. `$('#typo')` returns null,
// the next line throws inside the top-level IIFE, and *every* handler after it
// is never registered — the panel loads and simply does nothing.
//
// This reads the files as text and checks the wiring that a typo breaks.

const rendererRoot = path.join(__dirname, '..', 'renderer');
const rendererSource = fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8');
const iconsSource = fs.readFileSync(path.join(rendererRoot, 'icons.js'), 'utf8');
const markup = ['index.html', 'permissions.html']
  .map((file) => fs.readFileSync(path.join(rendererRoot, file), 'utf8'))
  .join('\n');

function matchAll(source, pattern) {
  return Array.from(source.matchAll(pattern), (match) => match[1]);
}

const declaredIds = new Set(matchAll(markup, /\bid="([^"]+)"/g));

test('every element the renderer reaches for with $() exists in the markup', () => {
  // Only `$('#id')` is checked, not getElementById: the codebase uses
  // getElementById for the lookup-then-create pattern (#toast, #cue-status,
  // #mic-perm-banner are built on first use and legitimately absent), while
  // `$()` results are dereferenced immediately and must be there.
  const missing = new Set();
  for (const id of matchAll(rendererSource, /\$\('#([A-Za-z0-9_-]+)'\)/g)) {
    if (!declaredIds.has(id)) missing.add(id);
  }
  assert.deepEqual([...missing], [], 'renderer.js looks up ids that no HTML file declares');
});

test('every action button the renderer paints an icon into exists', () => {
  const modes = matchAll(rendererSource, /\.act\[data-mode="([a-zA-Z]+)"\]/g);
  assert.ok(modes.length > 0, 'expected the renderer to paint action-button icons');
  for (const mode of modes) {
    assert.ok(
      markup.includes(`data-mode="${mode}"`),
      `renderer.js paints .act[data-mode="${mode}"] but no such button is in the markup`
    );
  }
});

test('every icon the renderer asks for is defined in icons.js', () => {
  const defined = new Set([
    ...matchAll(iconsSource, /^\s{4}'?([A-Za-z0-9-]+)'?:\s/gm),
    'logo'
  ]);
  const requested = new Set(matchAll(rendererSource, /\bicon\('([A-Za-z0-9-]+)'/g));
  assert.ok(requested.size > 0, 'expected the renderer to request icons');
  for (const name of requested) {
    assert.ok(defined.has(name), `icon('${name}') is requested but not defined in icons.js`);
  }
});

test('every preload API the renderer calls is exposed by preload.js', () => {
  // A renderer calling `cue.somethingNew()` that preload never exposed is a
  // TypeError at click time, and the usual cause is forgetting one of the
  // files when adding an IPC channel.
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const exposed = new Set(matchAll(preloadSource, /^\s{2}([A-Za-z0-9_]+):/gm));
  const used = new Set(matchAll(rendererSource, /\bcue\.([A-Za-z0-9_]+)\s*\(/g));
  for (const name of used) {
    assert.ok(exposed.has(name), `renderer calls cue.${name}() which preload.js does not expose`);
  }
});

test('every channel the renderer subscribes to is on the preload allowlist', () => {
  // preload.js drops unlisted channels silently — the classic "the feature
  // works in main and nothing happens in the UI" bug.
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const allowlist = preloadSource.slice(preloadSource.indexOf('const allowed = ['));
  const allowed = new Set(matchAll(allowlist.slice(0, allowlist.indexOf(']')), /'([^']+)'/g));
  const subscribed = matchAll(rendererSource, /cue\.on\('([^']+)'/g);

  assert.ok(subscribed.length > 0, 'expected the renderer to subscribe to channels');
  for (const channel of subscribed) {
    assert.ok(allowed.has(channel), `renderer subscribes to '${channel}', missing from the preload allowlist`);
  }
});

test('the drag handle opts its descendants into the drag region explicitly', () => {
  // `-webkit-app-region` is NOT inherited in Chromium. A child of a `drag`
  // element with no rule of its own computes to `none`, so the pill's label and
  // dot grid were dead holes in the centre of the control labelled "Drag":
  // only its few pixels of padding actually moved the window.
  //
  // This checks the rule still exists, because the failure is invisible — the
  // pill looks identical either way, and nothing throws.
  const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
  const descendantRule = /\.drag-pill\s*\*[^{]*\{[^}]*-webkit-app-region:\s*drag/;
  assert.match(css, descendantRule, '.drag-pill descendants must set -webkit-app-region: drag');
});

test('toolbar buttons are never swept into the drag region', () => {
  // The counterpart to the rule above: if a descendant selector ever grows to
  // cover buttons, the toolbar becomes undraggable *and* unclickable.
  const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
  const dragRules = css.match(/^[^{}]*\{[^}]*-webkit-app-region:\s*drag[^}]*\}/gm) || [];
  for (const rule of dragRules) {
    const selector = rule.slice(0, rule.indexOf('{'));
    assert.ok(
      !/\bbutton\b/.test(selector),
      `a drag region must not select buttons, but this one does: ${selector.trim()}`
    );
  }
});

test('the action row wraps instead of pushing buttons out of the panel', () => {
  // With five actions the row no longer fits a 700px window on one line.
  // `flex-wrap: nowrap` did not clip visibly — it pushed Recap outside the
  // panel bounds, where it was simply unreachable.
  const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
  const rule = css.match(/#action-row\s*\{[^}]*\}/);
  assert.ok(rule, '#action-row rule not found');
  assert.ok(!/flex-wrap:\s*nowrap/.test(rule[0]), '#action-row must not be nowrap');
  assert.match(rule[0], /flex-wrap:\s*wrap/);
});
