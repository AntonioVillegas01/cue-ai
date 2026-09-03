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

test('every channel preload invokes has a handler in main.js', () => {
  // The third file in the chain. preload can expose a method and the renderer
  // can call it, and the promise still rejects at runtime if main never
  // registered the handler — with nothing in the UI to say why.
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  // Not just main.js: applink.js registers its consent listener on demand, so
  // the whole main-process side is scanned.
  const srcDir = path.join(__dirname, '..', 'src');
  const mainSide = [path.join(__dirname, '..', 'main.js')]
    .concat(fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => path.join(srcDir, f)))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const handled = new Set([
    ...matchAll(mainSide, /ipcMain\.handle\('([^']+)'/g),
    ...matchAll(mainSide, /ipcMain\.on\('([^']+)'/g)
  ]);
  const invoked = matchAll(preloadSource, /ipcRenderer\.(?:invoke|send)\('([^']+)'/g);

  assert.ok(invoked.length > 0, 'expected preload to bridge some channels');
  const missing = invoked.filter((channel) => !handled.has(channel));
  assert.deepEqual(missing, [], 'preload bridges channels main.js never handles');
});

test('the multi-capture strip is wired end to end', () => {
  // The feature spans four files and its failure mode is a key that silently
  // does nothing, so each link is asserted rather than assumed.
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /CommandOrControl\+Alt\+C/, 'the capture shortcut must be registered');
  assert.match(mainSource, /CommandOrControl\+Alt\+P/, 'the solve-captures shortcut must be registered');
  // Escape is registered on demand: a permanently held global Escape would
  // swallow the key in every other application.
  assert.match(mainSource, /globalShortcut\.register\('Escape'/, 'Escape must cancel a staged session');
  assert.match(mainSource, /globalShortcut\.unregister\('Escape'\)/, 'Escape must be released when nothing is staged');
  assert.ok(rendererSource.includes("cue.on('capture:shots'"), 'the panel must track the staged count');
});

test('an .act button without a data-mode is never routed through runMode', () => {
  // The multi-capture button reuses the action-row styling but stages a
  // screenshot instead of running a mode. If the click handler were bound to
  // every `.act`, it would call runMode(undefined): the panel flips to busy and
  // no llm:done ever arrives to flip it back, so the UI is dead until restart.
  assert.match(
    rendererSource,
    /querySelectorAll\('\.act\[data-mode\]'\)/,
    'the action-row click handler must select .act[data-mode], not every .act'
  );
});

test('the multi-capture button is in the action row and wired to staging', () => {
  assert.ok(markup.includes('id="capture-btn"'), 'the action row must offer multi-capture');
  assert.ok(!/id="capture-btn"[^>]*data-mode/.test(markup), 'the capture button must not declare a data-mode');
  assert.match(rendererSource, /captureBtn\.addEventListener\('click', \(\) => \{ cue\.captureAdd\(\); \}\)/);
});

// ── Panel layout: the chain that lets the window grow vertically ────────────

// Comments are stripped first: nearly every rule below is preceded by one, and
// they are prose that would otherwise have to be matched around.
const stylesSource = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The declarations of one rule, matched only when the selector stands alone —
// so `#panel {` is found and neither `#panel-wrap {` nor the long
// `-webkit-app-region` selector list is mistaken for it.
function ruleBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('(?:^|\\})\\s*' + escaped + '\\s*\\{([^}]*)\\}').exec(stylesSource);
  return match ? match[1] : null;
}

test('the panel fills the window height so the grip resizes something visible', () => {
  // The bug this guards against: `#panel` had only a `max-height`, which left
  // it content-sized. flex-grow distributes free space and an auto-height
  // parent has none, so the whole `flex: 1` chain below collapsed to its
  // content. Dragging the grip down resized the window and changed nothing on
  // screen — the panel stayed the same height and the grip never moved. The
  // horizontal axis worked all along because the width is tied to the viewport
  // (`min(1100px, 94vw)`), which is exactly why only one axis looked broken.
  const wrap = ruleBlock('#panel-wrap');
  assert.ok(wrap, 'expected a #panel-wrap rule');
  assert.match(wrap, /flex:\s*1 1 auto/, '#panel-wrap must claim the leftover window height');
  assert.match(wrap, /min-height:\s*0/, 'without min-height:0 a flex item refuses to shrink below content');

  const panel = ruleBlock('#panel');
  assert.ok(panel, 'expected a #panel rule');
  assert.match(panel, /height:\s*100%/, '#panel needs a definite height for its children to grow into');

  for (const selector of ['#panel-columns', '#panel-main', '#messages']) {
    assert.match(ruleBlock(selector), /flex:\s*1/, `${selector} must grow with the panel`);
  }
});

test('the answer pane has no height cap that would strand the composer', () => {
  // With the panel filling the window, a `max-height` here cannot make the
  // panel smaller — it only leaves dead space inside the glass between the
  // answer and the composer once the window is tall enough for the cap to bite.
  assert.ok(!/max-height/.test(ruleBlock('#messages')), '#messages must not cap its own height');
});

test('hiding the panel releases the height the wrap was claiming', () => {
  // #panel-wrap is in the click-through hit test. Left at full height with the
  // panel hidden, it becomes a full-window invisible box that swallows clicks
  // meant for whatever is behind cue.
  assert.match(ruleBlock('#panel-wrap.collapsed'), /flex:\s*0 0 auto/);
  assert.match(
    rendererSource,
    /\$\('#panel-wrap'\)\.classList\.toggle\('collapsed', collapsed\)/,
    'toggleHide must collapse the wrap, not only the panel'
  );
  assert.match(
    rendererSource,
    /closest\([^)]*#panel-wrap/,
    'the click-through hit test is what makes the rule above load-bearing'
  );
});

test('the app leaves room below the panel for the resize grip', () => {
  // The grip hangs 9px below the panel. Flush against the window edge, its
  // bottom half falls outside the window and cannot be grabbed.
  assert.match(ruleBlock('#app'), /padding-bottom:\s*\d+px/);
});

// ── Code blocks ────────────────────────────────────────────────────────────

test('line numbers live outside the <pre>, so Copy returns the code alone', () => {
  // Copy sends `pre.textContent`, and a selection dragged across the card picks
  // up everything inside it. A gutter appended into the <pre> would put "1 2 3"
  // in front of every line the user pastes into their editor — silently, and
  // only noticed once the paste fails to compile.
  const decorate = rendererSource.slice(
    rendererSource.indexOf('function decorateCodeBlocks'),
    rendererSource.indexOf('// ---- answers that hit the token ceiling')
  );
  assert.ok(decorate.length > 0, 'expected to find decorateCodeBlocks');
  assert.ok(
    /body\.appendChild\(gutter\)/.test(decorate),
    'the gutter must be appended to the body wrapper'
  );
  assert.ok(
    !/pre\.appendChild|pre\.insertBefore|pre\.prepend/.test(decorate),
    'nothing may be inserted into the <pre> — it is what Copy reads'
  );
  assert.match(decorate, /cue\.copyText\(pre\.textContent/, 'Copy must read the pre itself');
  assert.match(decorate, /aria-hidden/, 'the gutter is decorative and must be hidden from assistive tech');
});

test('the gutter is aligned to the code by sharing its type metrics', () => {
  // Any divergence in font, size or line-height drifts a fraction of a row per
  // line and is visibly wrong well before the bottom of a long solution.
  const gutter = ruleBlock('.code-gutter');
  assert.ok(gutter, 'expected a .code-gutter rule');
  for (const prop of ['font-family', 'font-size', 'line-height', 'letter-spacing']) {
    assert.ok(gutter.includes(prop), `.code-gutter must pin ${prop} to match the code`);
  }
  assert.match(gutter, /user-select:\s*none/, 'line numbers must not be selectable');
});

test('code blocks scroll sideways instead of re-wrapping long lines', () => {
  const pre = ruleBlock('.ai-text pre');
  assert.match(pre, /white-space:\s*pre\b/, 'pre-wrap would re-flow the code that was written');
  assert.match(pre, /overflow-x:\s*auto/);
});

test('inline code is styled everywhere it can appear, not only in paragraphs', () => {
  // It used to be `.ai-text p code`, so inline code in a bullet — where this
  // model puts most of it — silently lost its chip styling.
  assert.ok(!/\.ai-text p code\s*\{/.test(stylesSource), 'inline code is still scoped to <p>');
  assert.ok(ruleBlock('.ai-text :not(pre) > code'), 'expected inline code to be styled outside <pre>');
});

test('the language label is not upper-cased back into an extension', () => {
  // highlight.js maps `ts` to "TypeScript"; a `text-transform: uppercase` on the
  // header undid that and rendered "TYPESCRIPT", which is the thing the mapping
  // exists to avoid.
  assert.ok(!/text-transform:\s*uppercase/.test(ruleBlock('.code-lang')));
});

test('a staged capture session has three advertised exits', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // Each runs an ordinary mode; runFeature is what prefers the staged session
  // over a fresh screenshot, so no mode needs any knowledge of captures.
  const exits = [
    ['CommandOrControl\\+Alt\\+P', 'SOLVE_CAPTURES_ACCELERATOR', 'leetcode', 'capture-solve-btn'],
    ['CommandOrControl\\+Alt\\+T', 'TEST_CAPTURES_ACCELERATOR', 'tests', 'capture-test-btn'],
    ['CommandOrControl\\+Alt\\+R', 'REFACTOR_CAPTURES_ACCELERATOR', 'refactor', 'capture-refactor-btn']
  ];
  for (const [accelerator, constant, mode, id] of exits) {
    assert.match(mainSource, new RegExp(accelerator), `${mode}: accelerator missing`);
    assert.match(mainSource, new RegExp(constant + ", \\(\\) => runFeature\\('" + mode + "'"), `${mode}: not wired to runFeature`);
    // And the same exit has to be reachable by mouse.
    assert.ok(markup.includes(`id="${id}"`), `${mode}: the strip must offer a button`);
    assert.match(
      rendererSource,
      new RegExp("#" + id + "'\\)\\.addEventListener\\('click', \\(\\) => runMode\\('" + mode + "'"),
      `${mode}: the strip button is not wired`
    );
  }
});

test('every accelerator cue registers is distinct', () => {
  // A second `register` of a held accelerator silently returns false, and the
  // only symptom is a key that does nothing.
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const registerSection = mainSource.slice(mainSource.indexOf('function registerShortcuts'));
  const literals = matchAll(registerSection.slice(0, registerSection.indexOf('\n}')), /register\('([^']+)'/g);
  assert.ok(literals.length > 0, 'expected registerShortcuts to register accelerators');
  assert.deepEqual(
    literals.filter((a, i) => literals.indexOf(a) !== i), [],
    'the same accelerator is registered twice'
  );
});

test('the capture strip advertises the shortcuts it actually has', () => {
  const strip = rendererSource.slice(rendererSource.indexOf('function renderCaptureStrip'));
  for (const keys of ['CAPTURE_KEYS', 'SOLVE_KEYS', 'TEST_KEYS', 'REFACTOR_KEYS']) {
    assert.ok(strip.includes(keys), `the strip hint must mention ${keys}`);
  }
});

test('the capture buttons wrap as one group and stay inside the panel', () => {
  // At the narrowest window the four buttons no longer fit beside the label and
  // were pushed past the panel's right edge — unreachable, "Solve" first. And
  // once the strip could wrap, the flex spacer stranded whichever single button
  // still fitted on the previous row, so they have to move as a block.
  assert.match(ruleBlock('.capture-strip'), /flex-wrap:\s*wrap/);
  const actions = ruleBlock('.capture-actions');
  assert.ok(actions, 'the buttons must share a group element');
  assert.match(actions, /flex:\s*none/, 'the group must not be split by the flex layout');
  const stripMarkup = markup.slice(markup.indexOf('id="capture-strip"'));
  const group = stripMarkup.slice(stripMarkup.indexOf('capture-actions'), stripMarkup.indexOf('</div>', stripMarkup.indexOf('capture-solve-btn')));
  for (const id of ['capture-clear-btn', 'capture-test-btn', 'capture-refactor-btn', 'capture-solve-btn']) {
    assert.ok(group.includes(id), `${id} must live inside .capture-actions`);
  }
});

test('the capture strip degrades by truncating the hint, not by breaking labels', () => {
  // With three buttons the strip no longer fits a narrow panel, and the default
  // was to wrap inside the words — "Test / all" stacked onto two lines. The
  // hint is the one element that can be cut, because the buttons beside it say
  // the same thing.
  const hint = ruleBlock('.capture-hint');
  assert.match(hint, /text-overflow:\s*ellipsis/);
  assert.match(hint, /min-width:\s*0/, 'a flex child needs min-width:0 before it will ellipsize');
  for (const selector of ['.capture-btn', '.capture-label', '.capture-hint']) {
    assert.match(ruleBlock(selector), /white-space:\s*nowrap/, `${selector} must not break mid-label`);
  }
});

test('an optional credential row is never painted as a missing one', () => {
  // The Anthropic workspace id shares data-key-for="anthropic" with the API key
  // so it highlights with its provider, but an empty workspace id is the normal
  // case — flagging it would send users hunting for a value most keys never
  // need, and filling it would not fix the missing key it was pointing at.
  assert.match(markup, /id="anthropic-workspace-id"/);
  const row = markup.slice(markup.lastIndexOf('<div', markup.indexOf('id="anthropic-workspace-id"')), markup.indexOf('id="anthropic-workspace-id"'));
  assert.ok(row.includes('data-optional'), 'the workspace row must be marked optional');
  assert.match(
    rendererSource,
    /is-missing', isActive && missing && !row\.hasAttribute\('data-optional'\)/,
    'the missing highlight must skip optional rows'
  );
});

test('hide/show has a shortcut, and it is not the macOS Help key', () => {
  // The binding existed all along on CommandOrControl+Shift+/ — which on macOS
  // is how ⌘? (Help) is typed, so it fought the OS for the key on the platform
  // it mattered on, and nothing in the UI announced it either way.
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /HIDE_ACCELERATOR = 'CommandOrControl\+Alt\+Down'/);
  assert.match(mainSource, /shortcutState\.hide = globalShortcut\.register\(HIDE_ACCELERATOR/);
  assert.ok(!mainSource.includes("register('CommandOrControl+Shift+/'"), 'the Help-key binding is back');
});

test('the Hide button advertises the shortcut and says which way it goes', () => {
  // The feature was unused because nothing named the key. The toolbar has no
  // room for a visible hint, so it goes in the tooltip like its neighbours.
  assert.match(rendererSource, /HIDE_KEYS = isMac \? '⌘⌥↓' : 'Ctrl\+Alt\+↓'/);
  assert.match(rendererSource, /#hide-btn'\)\.title = 'Hide the panel \(' \+ HIDE_KEYS/);
  // While collapsed the panel that would have explained the button is gone, so
  // the label has to flip.
  assert.match(rendererSource, /collapsed \? 'Show' : 'Hide'/);
});

test('toolbar tooltips name keys the running platform actually has', () => {
  // Quit's tooltip was hardcoded to the mac combination in the markup.
  assert.ok(!/id="quit-btn"[^>]*title="Quit cue \(⌘⇧X\)"/.test(markup), 'the mac-only tooltip is back in the markup');
  assert.match(rendererSource, /Quit cue \(' \+ \(isMac \? '⌘⇧X' : 'Ctrl\+Shift\+X'\)/);
});
