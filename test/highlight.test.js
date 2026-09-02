const assert = require('node:assert/strict');
const test = require('node:test');
const { highlightCode, escapeHtml } = require('../renderer/highlight.js');

// ── Escaping ────────────────────────────────────────────────────────────────
// This output goes straight into innerHTML, and the code it highlights was
// written by a model reading the user's screen and meeting transcript. Every
// one of these is an injection attempt that has to come out inert.

test('escapes markup that appears as bare code', () => {
  const html = highlightCode('<script>alert(1)</script>', 'js');
  assert.ok(!html.includes('<script'), 'a raw <script> tag reached the output');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('escapes markup hidden inside a string literal', () => {
  const html = highlightCode('const x = "<img src=x onerror=alert(1)>";', 'js');
  // The payload text may appear — inert — but it must never open a tag.
  assert.ok(!html.includes('<img'), 'a raw <img> tag reached the output');
  assert.ok(html.includes('&lt;img'), 'the angle bracket was not escaped');
  // The only tags in the output are this file's own spans.
  const tags = [...html.matchAll(/<\/?([a-zA-Z][^\s/>]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)], ['span'], 'a tag other than <span> reached the output');
});

test('escapes markup hidden inside a comment', () => {
  const html = highlightCode('# </span><script>alert(1)</script>', 'python');
  assert.ok(!html.includes('<script'));
  // The span this file opens must not be closeable by the input.
  assert.equal(html.match(/<span/g).length, html.match(/<\/span>/g).length);
});

test('escapes quotes and ampersands so attributes cannot be broken out of', () => {
  const html = highlightCode('a = "x" & \'y\'', 'python');
  assert.ok(!/[^&]"/.test(html.replace(/class="[^"]*"/g, '')), 'a bare double quote survived');
  assert.ok(html.includes('&amp;'));
});

test('every span this emits is one of its own fixed classes', () => {
  // Covers a capitalised identifier and JSX too, so the allowlist is exercised
  // in full rather than passing because the sample happened to be plain.
  const samples = [
    ['def f(x):\n  # note\n  return "s" + 1', 'python'],
    ['export function App(): JSX.Element { return <Button n={1} />; } // note', 'tsx']
  ];
  for (const [code, lang] of samples) {
    const html = highlightCode(code, lang);
    for (const cls of html.matchAll(/<span class="([^"]*)">/g)) {
      assert.match(cls[1], /^tok-(com|str|num|kw|fn|type)$/, `unexpected class ${cls[1]}`);
    }
  }
});

test('the plain text is preserved exactly once the tags are stripped', () => {
  // Nothing dropped, nothing duplicated — the classic tokenizer bug.
  const source = 'def solve(nums):\n    # 1.- Define result\n    total = 0\n    return total';
  const text = highlightCode(source, 'python')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(text, source);
});

test('preserves text exactly for input full of metacharacters', () => {
  const source = 'x = a < b && c > d ? "q\'s" : `t`; /* 1 */ # 2';
  const text = highlightCode(source, 'js')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(text, source);
});

// ── Tokenizing ──────────────────────────────────────────────────────────────

test('marks keywords, calls, strings, numbers and comments', () => {
  const html = highlightCode('def solve(n):\n    # step\n    return "x" + 42', 'python');
  assert.ok(html.includes('<span class="tok-kw">def</span>'));
  assert.ok(html.includes('<span class="tok-fn">solve</span>'));
  assert.ok(html.includes('<span class="tok-com"># step</span>'));
  assert.ok(html.includes('<span class="tok-str">&quot;x&quot;</span>'));
  assert.ok(html.includes('<span class="tok-num">42</span>'));
});

test('a keyword inside a string stays a string', () => {
  const html = highlightCode('msg = "return the value"', 'python');
  assert.ok(!html.includes('tok-kw'), 'highlighted a keyword that was inside a string');
});

test('a numbered step comment survives intact — it is the point of the answer', () => {
  const html = highlightCode('# 1.- Define a variable for the result', 'python');
  assert.ok(html.includes('1.- Define a variable for the result'));
  assert.ok(html.includes('tok-com'));
});

test('handles block comments and docstrings that span lines', () => {
  assert.ok(highlightCode('/*\n 1.- a\n 2.- b\n*/\nx = 1', 'js').includes('tok-com'));
  assert.ok(highlightCode('"""\n1.- a\n"""\nx = 1', 'python').includes('tok-com'));
});

test('a mid-line # is left alone in languages where it is not a comment', () => {
  // JavaScript private fields would otherwise swallow the rest of the line.
  const html = highlightCode('class A { #count = 0; }', 'js');
  assert.ok(!html.includes('tok-com'), '# was treated as a comment in JavaScript');
  assert.ok(html.includes('<span class="tok-num">0</span>'), 'the rest of the line stopped being tokenized');
});

test('a line-leading # is a comment even without a language tag', () => {
  assert.ok(highlightCode('  # a note\nx = 1', '').includes('tok-com'));
});

test('empty and non-string input produce nothing rather than throwing', () => {
  assert.equal(highlightCode('', 'js'), '');
  assert.equal(highlightCode(null, 'js'), '');
  assert.equal(highlightCode(undefined), '');
});

test('escapeHtml is exported and covers the four dangerous characters', () => {
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;');
});

// ── The target stack: JavaScript / TypeScript / Node / React ────────────────
// `function` was missing from the keyword set entirely, which is the kind of
// gap that is invisible until you look at real output.

test('highlights the core JavaScript keywords', () => {
  const html = highlightCode('export function run() { return await fetch(url) instanceof Response; }', 'js');
  for (const kw of ['export', 'function', 'return', 'await', 'instanceof']) {
    assert.ok(html.includes('>' + kw + '</span>'), `${kw} was not highlighted as a keyword`);
  }
});

test('highlights for...of, which is the idiomatic JS loop', () => {
  const html = highlightCode('for (const item of items) {}', 'js');
  assert.ok(html.includes('<span class="tok-kw">of</span>'));
  assert.ok(html.includes('<span class="tok-kw">const</span>'));
});

test('highlights the TypeScript type vocabulary', () => {
  const html = highlightCode('type Id = keyof Props; declare const x: unknown satisfies never;', 'ts');
  for (const kw of ['type', 'keyof', 'declare', 'unknown', 'satisfies', 'never']) {
    assert.ok(html.includes('>' + kw + '</span>'), `${kw} was not highlighted`);
  }
});

test('React components and types read as types, not as plain text', () => {
  const html = highlightCode('return <Button onClick={handle}>Go</Button>;', 'tsx');
  assert.ok(html.includes('<span class="tok-type">Button</span>'), 'the component name was not highlighted');
  // The JSX itself must still be escaped — this is markup arriving from a model.
  assert.ok(!html.includes('<Button'), 'raw JSX reached the DOM as markup');
  assert.ok(html.includes('&lt;'));
});

test('a constructed built-in reads as a type rather than a call', () => {
  const html = highlightCode('const seen = new Map();', 'ts');
  assert.ok(html.includes('<span class="tok-kw">new</span>'));
  assert.ok(html.includes('<span class="tok-type">Map</span>'));
});

test('does not colour get/set/constructor, which are ordinary names here', () => {
  // `const set = new Set()` is common; coloring `set` as a keyword is worse
  // than leaving it plain.
  const html = highlightCode('const set = new Set(); const get = 1;', 'ts');
  assert.ok(!html.includes('<span class="tok-kw">set</span>'));
  assert.ok(!html.includes('<span class="tok-kw">get</span>'));
  assert.ok(html.includes('<span class="tok-type">Set</span>'));
});

test('a template literal is one string, braces and all', () => {
  const html = highlightCode('const s = `id-${user.id}-end`;', 'ts');
  assert.ok(html.includes('tok-str'));
  const text = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.ok(text.includes('`id-${user.id}-end`'));
});

test('the keyword set has no bogus entries', () => {
  // Regression: two keywords were concatenated by a missing space, producing
  // `staticstring` — a token that matches nothing and hid a real one.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'highlight.js'), 'utf8');
  assert.ok(!source.includes('staticstring'));
  // And `function` must be present, since it is the most common JS keyword.
  assert.ok(highlightCode('function f() {}', 'js').includes('<span class="tok-kw">function</span>'));
});
