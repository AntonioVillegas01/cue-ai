const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, CODE_MODES } = require('../src/prompts');

test('assist mode gives a direct answer in first person', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  // System prompt must instruct to answer in first person with no preamble
  assert.match(text, /first person/i);
  assert.match(text, /no preamble|preamble/i);
});

test('say mode produces a spoken answer not a question', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /say out loud|in first person/i);
  // Must instruct to write actual spoken words (not meta-instructions)
  assert.match(text, /actual words|Write the|2.5 sentences/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('followup mode returns a bullet list', () => {
  const system = MODES.followup.buildSystem(null);
  assert.match(system, /bullet list|bullets/i);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

// ── AI rules ────────────────────────────────────────────────────────────────
const RULES = 'Never use em-dashes.\nReply in 2-3 short bullet points.\nUse a casual tone.';

test('every conversational mode injects AI rules into its system prompt', () => {
  // Driven off CODE_MODES rather than a hardcoded name, so a new code mode is
  // covered the day it is added instead of failing this test.
  for (const [name, mode] of Object.entries(MODES)) {
    if (CODE_MODES.has(name)) continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /--- USER RULES ---/, `${name}.buildSystem should append USER RULES block`);
    assert.ok(withRules.includes(RULES), `${name}.buildSystem should include the user's rules verbatim`);
  }
});

test('every conversational mode returns the base prompt unchanged when no rules are set', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (CODE_MODES.has(name)) continue;
    const without = mode.buildSystem(null, '');
    const blank = mode.buildSystem(null, null);
    assert.ok(!without.includes('USER RULES'), `${name} should not include USER RULES when aiRules is empty`);
    assert.ok(!blank.includes('USER RULES'), `${name} should not include USER RULES when aiRules is null`);
  }
});

test('no code mode ever applies AI rules or personal context (code answers stay strict)', () => {
  for (const name of CODE_MODES) {
    const withRules = MODES[name].buildSystem('IGNORED_CONTEXT', RULES);
    assert.ok(!withRules.includes('USER RULES'), `${name} must not include USER RULES`);
    assert.ok(!withRules.includes(RULES), `${name} must not leak user rules into the prompt`);
    assert.ok(!withRules.includes('IGNORED_CONTEXT'), `${name} must not include the context block`);
  }
});

test('every mode named in CODE_MODES actually exists', () => {
  for (const name of CODE_MODES) {
    assert.ok(MODES[name], `CODE_MODES lists ${name}, which is not a mode`);
    assert.equal(MODES[name].memoryScope, 'coding', `${name} should share the coding memory scope`);
  }
});
// ── Token budgets and memory scopes ─────────────────────────────────────────
// Both exist for the coding-challenge flow: a full solution does not fit in
// the conversational default, and coding help must not inherit interview
// context (or leak into it).

test('leetcode asks for a budget big enough to hold a whole solution', () => {
  const budget = MODES.leetcode.maxTokens;
  assert.equal(typeof budget.fast, 'number');
  assert.equal(typeof budget.smart, 'number');
  assert.ok(budget.fast >= 2000, 'a restatement, approach, solution and complexity need room');
  assert.ok(budget.smart >= budget.fast, 'the smart tier must not be tighter than the fast one');
});

test('a declared token budget always has both tiers', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (!mode.maxTokens) continue;
    assert.equal(typeof mode.maxTokens.fast, 'number', `${name}.maxTokens.fast`);
    assert.equal(typeof mode.maxTokens.smart, 'number', `${name}.maxTokens.smart`);
    assert.ok(mode.maxTokens.fast > 0 && mode.maxTokens.smart > 0, `${name}.maxTokens must be positive`);
  }
});

test('leetcode keeps its own memory scope so interview history cannot reach it', () => {
  assert.equal(MODES.leetcode.memoryScope, 'coding');
});

test('ask adopts the open scope, so a typed follow-up continues the last solve', () => {
  assert.equal(MODES.ask.memoryScope, 'any');
  assert.equal(MODES.continue.memoryScope, 'any');
});

test('every declared memory scope is one the memory understands', () => {
  const allowed = new Set(['coding', 'interview', 'any']);
  for (const [name, mode] of Object.entries(MODES)) {
    if (!mode.memoryScope) continue;
    assert.ok(allowed.has(mode.memoryScope), `${name}.memoryScope ${mode.memoryScope} is not a known scope`);
  }
});

// ── Continue ────────────────────────────────────────────────────────────────

test('continue borrows the system prompt of the mode that was cut off', () => {
  assert.equal(MODES.continue.inheritSystemFromLastMode, true);
});

test('continue asks the model to resume rather than restart', () => {
  const prompt = MODES.continue.build({ transcript: [], userText: '' });
  assert.match(prompt, /continue/i);
  assert.match(prompt, /not repeat/i);
  assert.match(prompt, /code block/i);
});

test('continue does not re-capture the screen', () => {
  // The previous answer is already in the conversation memory; a second
  // screenshot would only add latency to something the user is waiting on.
  assert.equal(MODES.continue.needsScreen, false);
});

// ── Refactor ────────────────────────────────────────────────────────────────
// The risk with a "apply SOLID" prompt is not that the model ignores SOLID —
// it is that it applies all five mechanically and hands back a class hierarchy
// where a rename would have done. These assert the guardrails are in the prompt.

test('refactor reads the screen and answers in the language shown', () => {
  const system = MODES.refactor.buildSystem(null, null);
  assert.equal(MODES.refactor.needsScreen, true);
  assert.match(system, /screenshot/i);
  assert.match(system, /same language shown on screen/i);
});

test('refactor names all five SOLID principles', () => {
  const system = MODES.refactor.buildSystem(null, null);
  for (const principle of ['SRP', 'OCP', 'LSP', 'ISP', 'DIP']) {
    assert.ok(system.includes(principle), `the prompt should name ${principle}`);
  }
});

test('refactor tells the model simplicity outranks the principles', () => {
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /KEEP IT SIMPLE/);
  assert.match(system, /outranks/i);
  // The specific over-engineering failure modes, named so they can be refused.
  for (const trap of ['interfaces', 'factories', 'DI containers', 'indirection']) {
    assert.ok(system.includes(trap), `the prompt should warn against ${trap}`);
  }
});

test('refactor is told to preserve behaviour and to leave clean code alone', () => {
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /preserve the public API/i);
  assert.match(system, /already clean/i);
  assert.match(system, /smallest change/i);
});

test('refactor asks for the diagnosis, the code and the changes', () => {
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /What's wrong/);
  assert.match(system, /fenced code block/i);
  assert.match(system, /What changed/);
});

test('refactor gets a budget big enough for a rewritten unit', () => {
  assert.ok(MODES.refactor.maxTokens.fast >= 2000);
  assert.ok(MODES.refactor.maxTokens.smart >= MODES.refactor.maxTokens.fast);
});

test('refactor shares the coding memory scope, so follow-ups continue it', () => {
  // "now extract the validation too" has to reach the previous refactor, and
  // must never reach interview history.
  assert.equal(MODES.refactor.memoryScope, 'coding');
  assert.ok(CODE_MODES.has('refactor'));
});

test('refactor asks the user for nothing beyond the screenshot', () => {
  assert.equal(MODES.refactor.build(), 'Refactor the code shown in the screenshot.');
});

// ── Compact, senior-level code answers ──────────────────────────────────────
// These used to mandate a numbered step-comment block above every function, on
// the theory that the comments were the script the user reads aloud. In
// practice that doubled the height of every solution, and the panel is a small
// overlay — the reader spent the exercise scrolling past the explanation to
// reach the code. The answer is now the code itself, and the naming carries
// what the comment block used to.

test('leetcode asks for a principal-level answer, not just a working one', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /principal engineer/i);
  assert.match(system, /edge cases/i);
  assert.match(system, /maintainable solution over/i);
  assert.match(system, /tradeoff/i);
});

test('the solution section is pure code, with no comments at all', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /NO COMMENTS IN THE CODE/);
  assert.match(system, /Section 3 is pure code/i);
});

test('dropping comments does not drop the reasoning, it relocates it', () => {
  // Zero comments would lose the invariant and the edge-case rationale unless
  // the prompt says where they go instead — section 2 already exists for it.
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /The reasoning still has to exist/i);
  assert.match(system, /it goes in section 2, as prose/i);
});

test('the solution section no longer asks for a step-comment block', () => {
  // The specific thing that made every answer twice as tall. Asserted as an
  // absence because the regression would be re-adding it, not removing it.
  const system = MODES.leetcode.buildSystem(null, null);
  assert.ok(!system.includes('1.- '), 'the numbered step style is back in the prompt');
  assert.ok(!/above EVERY function/i.test(system), 'the per-function comment block is back');
  assert.match(system, /no block above the function, no numbered step ([\s\S]*?)list/i);
});

test('the solution section spends names instead of comments', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /Put the explanation in the NAMES/i);
});

test('compactness is bounded by readability, not pursued past it', () => {
  // Without this the instruction reads as "golf it", and a one-letter name
  // costs more reading time in an interview than the line it saved.
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /Compact is not cryptic/i);
  assert.match(system, /correct/i);
  assert.match(system, /scannable/i);
});

test('the solution section trims blank lines and dead code', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /No blank line after an opening brace/i);
  assert.match(system, /no unused helpers/i);
});

test('leetcode still asks for restatement, approach, code and complexity', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /restatement/i);
  assert.match(system, /approach/i);
  assert.match(system, /fenced code block/i);
  assert.match(system, /Time and space complexity/i);
});

test('refactor uses the same comment convention as the solver', () => {
  // One mode commented and the other not would read as a bug in the app — the
  // same reason this test existed when the convention was the opposite.
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /NO COMMENTS IN THE CODE/);
  assert.match(system, /Put the explanation in the NAMES/i);
  assert.match(system, /Compact is not cryptic/i);
  assert.ok(!system.includes('1.- '), 'the numbered step style is back in refactor');
});

test('refactor does not strip comments that were already in the user\'s file', () => {
  // "No comments" governs what the model WRITES. Deleting the author's existing
  // comments from lines it kept would be an unrequested change to their code.
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /keep only the ones that were already there/i);
  assert.match(system, /Never add a new one/i);
});

test('no code mode asks for a numbered step-comment block', () => {
  // A single sweep, so a future mode cannot quietly reintroduce the convention
  // in one place while the others stay compact.
  for (const mode of CODE_MODES) {
    const system = MODES[mode].buildSystem(null, null);
    assert.ok(!system.includes('1.- '), `${mode} still shows the numbered step style`);
    assert.ok(!/above EVERY function/i.test(system), `${mode} still mandates a per-function block`);
  }
});

test('every code mode forbids comments in the code it emits', () => {
  // Replaces an older test that pinned which comment SYNTAX to use. With zero
  // comments there is no syntax to pick, and the invariant worth holding is
  // that no code mode quietly goes back to emitting them.
  for (const mode of CODE_MODES) {
    assert.match(
      MODES[mode].buildSystem(null, null),
      /NO COMMENTS IN THE (CODE|TEST FILE)/,
      `${mode} does not forbid comments`
    );
  }
});

// ── Target stack ────────────────────────────────────────────────────────────
// The user interviews for JavaScript / TypeScript / Node / React roles. A
// prompt that defaults to Python answers the wrong interview.

test('both code modes are pinned to the JS/TS/Node/React stack', () => {
  for (const name of ['leetcode', 'refactor']) {
    const system = MODES[name].buildSystem(null, null);
    assert.match(system, /JAVASCRIPT \/ TYPESCRIPT \/ NODE \/ REACT/, `${name} should name the stack`);
    assert.match(system, /TypeScript if none is visible|answer in TypeScript/i, `${name} should default to TypeScript`);
  }
});

test('leetcode still honours the language actually on screen', () => {
  // Pinning the stack must not mean ignoring a problem posed in another language.
  assert.match(MODES.leetcode.buildSystem(null, null), /language visible on screen/i);
});

test('leetcode warns about the JavaScript traps that decide these interviews', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /sort comparator is\s+lexicographic|default `sort` comparator/i);
  assert.match(system, /for\.\.\.in/);
  assert.match(system, /NaN !== NaN/);
  assert.match(system, /2\^53/);
});

test('leetcode asks for real TypeScript typing, not escape hatches', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /No `any`/);
  assert.match(system, /non-null assertions/i);
});

test('refactor judges the code by React and Node idiom, not by Java patterns', () => {
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /discriminated union/i);
  assert.match(system, /passing a function or an object literal/i);
  assert.match(system, /extract a hook/i);
  assert.match(system, /separate the I\/O from the pure logic/i);
  // The anti-over-engineering rule has to survive the React section.
  assert.match(system, /no measured problem/i);
});

// ── Multi-capture (a challenge captured across several scrolls) ─────────────

test('a single capture produces the prompt it always did, with no scroll note', () => {
  const one = MODES.leetcode.build({ shots: 1 });
  assert.equal(one, 'Solve the coding problem shown in the screenshot.');
  // No shots field at all (an older caller, or a mode that never counted) must
  // behave the same as one.
  assert.equal(MODES.leetcode.build({}), one);
  assert.equal(MODES.leetcode.build(), one);
});

test('several captures instruct the model to stitch the overlap, not solve it twice', () => {
  const prompt = MODES.leetcode.build({ shots: 3 });
  assert.match(prompt, /3 screenshots/);
  assert.match(prompt, /consecutive scrolls/i);
  assert.match(prompt, /overlap/i);
  assert.match(prompt, /top to bottom/i);
  // The failure this guards against: answering only what the last screenshot shows.
  assert.match(prompt, /Reconstruct the complete/i);
});

test('the scroll note tells the model to flag a real gap instead of inventing it', () => {
  assert.match(MODES.leetcode.build({ shots: 2 }), /rather than inventing/i);
});

test('refactor gets the same treatment for a file longer than the screen', () => {
  assert.equal(MODES.refactor.build({ shots: 1 }), 'Refactor the code shown in the screenshot.');
  const many = MODES.refactor.build({ shots: 4 });
  assert.match(many, /4 screenshots/);
  assert.match(many, /Refactor the code shown across the screenshots\./);
});

test('scrollNote is silent below two captures', () => {
  const { scrollNote } = require('../src/prompts');
  assert.equal(scrollNote(0, 'coding problem'), '');
  assert.equal(scrollNote(1, 'coding problem'), '');
  assert.equal(scrollNote(undefined, 'coding problem'), '');
  assert.ok(scrollNote(2, 'coding problem').length > 0);
});

test('the screen-reading conversational modes also explain multiple captures', () => {
  // assist and ask take whatever is staged, so their prompt has to account for
  // it too — otherwise the model sees N images and no reason for them.
  const assist = MODES.assist.build({ transcript: [], userText: '', shots: 2 });
  assert.match(assist, /consecutive scrolls/i);
  const ask = MODES.ask.build({ transcript: [], userText: 'why?', shots: 2 });
  assert.match(ask, /consecutive scrolls/i);
  assert.match(ask, /Question: why\?/);
});

test('the conversational modes are unchanged when there is one capture', () => {
  const assist = MODES.assist.build({ transcript: [], userText: '', shots: 1 });
  assert.ok(assist.startsWith('Recent conversation:'));
  const ask = MODES.ask.build({ transcript: [], userText: 'why?', shots: 1 });
  assert.equal(ask, 'Question: why?');
});

// ── Tests mode (unit tests for the code on screen) ─────────────────────────

test('tests mode is a code mode: no personal context, no style rules', () => {
  // Same contract as leetcode and refactor. A test file must not be reshaped by
  // "use a casual tone" or by the candidate's résumé.
  assert.ok(CODE_MODES.has('tests'));
  const system = MODES.tests.buildSystem('IGNORED_CONTEXT', 'Never use semicolons.');
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'tests must not include the context block');
  assert.ok(!system.includes('Never use semicolons'), 'tests must not inherit the AI rules');
});

test('tests mode picks the framework from what is on screen', () => {
  const system = MODES.tests.buildSystem(null, '');
  assert.match(system, /React Testing Library/);
  assert.match(system, /Jest/);
  // The stack is detected, not asked for: the user is mid-exercise and cannot
  // answer a clarifying question.
  assert.match(system, /component or hook/i);
});

test('tests mode forbids the practices that make a suite worthless', () => {
  const system = MODES.tests.buildSystem(null, '');
  assert.match(system, /getByRole/, 'must prefer accessible queries');
  assert.match(system, /userEvent/, 'must prefer userEvent over fireEvent');
  assert.match(system, /shallow rendering/i, 'must rule out shallow rendering');
  assert.match(system, /snapshot/i, 'must take a position on snapshot tests');
  assert.match(system, /I\/O boundary/i, 'must confine mocking to the I/O boundary');
});

test('tests mode refuses to invent requirements the code never stated', () => {
  const system = MODES.tests.buildSystem(null, '');
  assert.match(system, /Do NOT invent requirements/);
  // A test that encodes a bug as expected behaviour is worse than no test.
  assert.match(system, /rather than writing a test that quietly encodes/i);
});

test('tests mode asks for one runnable file and reports what it skipped', () => {
  const system = MODES.tests.buildSystem(null, '');
  assert.match(system, /ONE fenced code block/);
  assert.match(system, /Not covered/);
});

test('tests mode carries the multi-capture scroll note like the other code modes', () => {
  assert.equal(MODES.tests.build({ shots: 1 }), 'Write the unit tests for the code shown in the screenshot.');
  const many = MODES.tests.build({ shots: 3 });
  assert.match(many, /3 screenshots/);
  assert.match(many, /Write the unit tests for the code shown across the screenshots\./);
});

test('tests mode budgets enough tokens for a whole suite', () => {
  // A suite cut off mid-`it` is worse than no suite: it looks finished.
  assert.ok(MODES.tests.maxTokens.fast >= 2500);
  assert.ok(MODES.tests.maxTokens.smart >= MODES.tests.maxTokens.fast);
});

test('tests mode keeps coding memory separate from interview memory', () => {
  assert.equal(MODES.tests.memoryScope, 'coding');
  assert.equal(MODES.tests.needsScreen, true);
});

// ── Minimal, paste-ready output ────────────────────────────────────────────

test('refactor returns a patch, not a copy of the input', () => {
  // The multi-capture case is where this bites: `scrollNote` tells the model to
  // reconstruct the whole file from the screenshots, and without this rule it
  // reprinted the whole reconstruction — five captured screens came back as
  // five screens of mostly untouched code that had to be diffed by eye.
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /RETURN ONLY WHAT CHANGED/);
  assert.match(system, /Never re-emit code you did not touch/i);
  assert.match(system, /reading all of it is required, reprinting all of it is not/i);
});

test('refactor keeps the changed units placeable', () => {
  // "Only what changed" is useless if the reader cannot tell where it goes.
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /enough of each unit's own signature/i);
  assert.match(system, /whole unit is\s*what changed, and returning it entire is correct/i);
});

test('refactor prose is capped and droppable', () => {
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /up to 3 bullets/i);
  assert.match(system, /Drop this section entirely when it would just narrate the diff/i);
});

test('tests mode bounds a multi-capture suite instead of covering everything', () => {
  // Three screens of code implies a suite nobody reads; the honest lever is the
  // "Not covered" section the mode already has.
  const system = MODES.tests.buildSystem(null, null);
  assert.match(system, /several screenshots/i);
  assert.match(system, /do not try to cover every unit/i);
  assert.match(system, /Not covered/);
});

test('the scroll note still asks for full reconstruction on the way in', () => {
  // The input-side rule must survive the output-side one: the model has to read
  // every capture even when it only reprints part of it.
  const { scrollNote } = require('../src/prompts');
  const note = scrollNote(3, 'file of code');
  assert.match(note, /Reconstruct the complete/i);
  assert.match(note, /OVERLAP/);
});

// ── Test framework is not negotiable ───────────────────────────────────────

test('the runner is pinned to Jest and the alternatives are named', () => {
  // "Use Jest" alone drifts: the model matches whatever imports it sees on
  // screen. Naming the runners to refuse is what makes "always" hold.
  const system = MODES.tests.buildSystem(null, null);
  assert.match(system, /THE RUNNER IS ALWAYS JEST/);
  for (const runner of ['Vitest', 'Mocha', 'node:test', 'Jasmine', 'AVA']) {
    assert.ok(system.includes(runner), `the prompt should refuse ${runner} by name`);
  }
  assert.match(system, /whatever the project on screen appears to use/i);
});

test('React work pins React Testing Library and refuses the alternatives', () => {
  const system = MODES.tests.buildSystem(null, null);
  assert.match(system, /React Testing Library/);
  for (const lib of ['Enzyme', 'react-test-renderer', 'shallow']) {
    assert.ok(system.includes(lib), `the prompt should refuse ${lib} by name`);
  }
  assert.match(system, /@testing-library\/react/);
  assert.match(system, /@testing-library\/user-event/);
  assert.match(system, /@testing-library\/jest-dom/);
});

test('a non-React target still uses Jest, alone', () => {
  assert.match(MODES.tests.buildSystem(null, null), /\*\*Jest\*\* alone/);
});

test('the test file itself carries no comments', () => {
  const system = MODES.tests.buildSystem(null, null);
  assert.match(system, /NO COMMENTS IN THE TEST FILE/);
  assert.match(system, /names ARE the documentation/i);
  // The non-obvious setup rationale has somewhere to go instead of vanishing.
  assert.match(system, /put that in the "Not covered" section/i);
});
