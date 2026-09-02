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

// ── Commented, senior-level code answers ────────────────────────────────────
// The user reads these aloud while sharing their screen, so the comments are
// the script. A solution that arrives uncommented is not usable for that.

test('leetcode asks for a principal-level answer, not just a working one', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /principal engineer/i);
  assert.match(system, /edge cases/i);
  assert.match(system, /maintainable solution over/i);
  assert.match(system, /tradeoff/i);
});

test('leetcode requires numbered English step comments above every function', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /above EVERY function/i);
  assert.match(system, /ENGLISH/);
  assert.match(system, /numbering the steps/i);
  // The exact style asked for, so the model copies the shape.
  assert.ok(system.includes('1.- '), 'the prompt should show the 1.- step style');
  assert.ok(system.includes('2.- '), 'the prompt should show more than one step');
});

test('leetcode forbids comments that just restate the syntax', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /Never comment the obvious/i);
  assert.match(system, /not a translation of the syntax/i);
});

test('leetcode still asks for restatement, approach, code and complexity', () => {
  const system = MODES.leetcode.buildSystem(null, null);
  assert.match(system, /restatement/i);
  assert.match(system, /approach/i);
  assert.match(system, /fenced code block/i);
  assert.match(system, /Time and space complexity/i);
});

test('refactor uses the same comment convention as the solver', () => {
  // One mode commented and the other not would read as a bug in the app.
  const system = MODES.refactor.buildSystem(null, null);
  assert.match(system, /ENGLISH/);
  assert.ok(system.includes('1.- '), 'refactor should show the same step style');
  assert.match(system, /Never restate the syntax/i);
});

test('code modes are told which comment syntax to use', () => {
  // A Python answer with // comments does not run.
  assert.match(MODES.leetcode.buildSystem(null, null), /own comment syntax/i);
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
