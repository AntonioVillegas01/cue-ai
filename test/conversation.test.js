const assert = require('node:assert/strict');
const test = require('node:test');
const { ConversationMemory } = require('../src/conversation');

test('starts empty and reports no exchanges', () => {
  const memory = new ConversationMemory();
  assert.deepEqual(memory.turns(), []);
  assert.equal(memory.exchanges, 0);
});

test('replays a recorded exchange as alternating user/assistant turns', () => {
  const memory = new ConversationMemory();
  memory.enter('coding');
  memory.record('Solve the coding problem shown in the screenshot.', 'def solve(nums): ...');

  assert.deepEqual(memory.turns(), [
    { role: 'user', text: 'Solve the coding problem shown in the screenshot.' },
    { role: 'assistant', text: 'def solve(nums): ...' }
  ]);
  assert.equal(memory.exchanges, 1);
});

test('records nothing when either half is missing', () => {
  // A dangling user turn would break providers that require strict alternation.
  const memory = new ConversationMemory();
  memory.record('question with no answer', '');
  memory.record('', 'answer with no question');
  memory.record('   ', '   ');
  assert.deepEqual(memory.turns(), []);
});

test('keeps only the most recent exchanges', () => {
  const memory = new ConversationMemory({ maxExchanges: 2 });
  memory.record('q1', 'a1');
  memory.record('q2', 'a2');
  memory.record('q3', 'a3');

  const texts = memory.turns().map((turn) => turn.text);
  assert.deepEqual(texts, ['q2', 'a2', 'q3', 'a3']);
});

test('clips each half so a transcript-bearing prompt cannot grow without bound', () => {
  const memory = new ConversationMemory({ maxUserChars: 10, maxAssistantChars: 5 });
  memory.record('u'.repeat(50), 'a'.repeat(50));

  const [user, assistant] = memory.turns();
  assert.equal(user.text.startsWith('uuuuuuuuuu'), true);
  assert.match(user.text, /truncated/);
  assert.equal(assistant.text.startsWith('aaaaa'), true);
  assert.match(assistant.text, /truncated/);
});

test('turns() hands out copies, so a caller cannot mutate the memory', () => {
  const memory = new ConversationMemory();
  memory.record('q', 'a');
  memory.turns()[0].text = 'tampered';
  assert.equal(memory.turns()[0].text, 'q');
});

// ---- scope isolation ------------------------------------------------------
// leetcode is documented as a context-free mode. Carrying interview history
// into it would undo that, and carrying code into "What should I say?" is just
// as wrong.

test('switching scope drops the memory instead of mixing the two', () => {
  const memory = new ConversationMemory();
  memory.enter('coding');
  memory.record('solve this', 'here is the code');

  assert.deepEqual(memory.enter('interview'), []);
  assert.equal(memory.exchanges, 0);
});

test('re-entering the same scope keeps the memory', () => {
  const memory = new ConversationMemory();
  memory.enter('coding');
  memory.record('solve this', 'here is the code');

  assert.equal(memory.enter('coding').length, 2);
});

test('the "any" scope adopts whatever is open — a typed follow-up to a solve', () => {
  const memory = new ConversationMemory();
  memory.enter('coding');
  memory.record('solve this', 'O(n^2) solution');

  // This is `ask` ("now make it O(n)") landing after ⌘H.
  const visible = memory.enter('any');
  assert.equal(visible.length, 2);
  assert.equal(visible[1].text, 'O(n^2) solution');

  // And it must not have changed which scope is open.
  assert.equal(memory.enter('coding').length, 2);
});

test('"any" on a fresh memory does not pin a scope', () => {
  const memory = new ConversationMemory();
  memory.enter('any');
  memory.record('q', 'a');
  // Still free to become either scope without losing the exchange.
  assert.equal(memory.enter('interview').length, 2);
});

test('clear() empties the memory and releases the scope', () => {
  const memory = new ConversationMemory();
  memory.enter('coding');
  memory.record('q', 'a');
  memory.clear();

  assert.deepEqual(memory.turns(), []);
  assert.equal(memory.exchanges, 0);
  memory.enter('interview');
  assert.deepEqual(memory.turns(), []);
});
