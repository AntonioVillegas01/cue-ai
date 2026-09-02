const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureSession, MAX_SHOTS } = require('../src/capture-session');

const shot = (n) => 'data:image/jpeg;base64,shot' + n;

test('a new session is empty and reports its cap', () => {
  const session = createCaptureSession();
  assert.equal(session.count, 0);
  assert.equal(session.max, MAX_SHOTS);
  assert.deepEqual(session.list(), []);
});

test('captures are kept in the order they were taken', () => {
  const session = createCaptureSession();
  session.add(shot(1));
  session.add(shot(2));
  session.add(shot(3));
  // Order is the whole point: the model is told these are scrolls from top to
  // bottom, which is only true if they arrive that way.
  assert.deepEqual(session.list(), [shot(1), shot(2), shot(3)]);
  assert.equal(session.count, 3);
});

test('add reports the running count so the caller can show it', () => {
  const session = createCaptureSession();
  assert.deepEqual(session.add(shot(1)), { added: true, reason: 'added', count: 1 });
  assert.deepEqual(session.add(shot(2)), { added: true, reason: 'added', count: 2 });
});

test('the same screen captured twice in a row is refused, not duplicated', () => {
  const session = createCaptureSession();
  session.add(shot(1));
  const again = session.add(shot(1));
  assert.deepEqual(again, { added: false, reason: 'duplicate', count: 1 });
  assert.equal(session.count, 1);
});

test('returning to an earlier screen after scrolling away is a real capture', () => {
  const session = createCaptureSession();
  session.add(shot(1));
  session.add(shot(2));
  // Only the immediately previous shot is compared — scrolling back on purpose
  // is legitimate, and dropping it would silently lose a capture.
  assert.equal(session.add(shot(1)).added, true);
  assert.deepEqual(session.list(), [shot(1), shot(2), shot(1)]);
});

test('an empty or non-string capture is refused', () => {
  const session = createCaptureSession();
  assert.deepEqual(session.add(''), { added: false, reason: 'empty', count: 0 });
  assert.deepEqual(session.add(null), { added: false, reason: 'empty', count: 0 });
  assert.deepEqual(session.add(undefined), { added: false, reason: 'empty', count: 0 });
  assert.equal(session.count, 0);
});

test('the session refuses to grow past its cap', () => {
  const session = createCaptureSession({ max: 3 });
  session.add(shot(1));
  session.add(shot(2));
  session.add(shot(3));
  assert.deepEqual(session.add(shot(4)), { added: false, reason: 'full', count: 3 });
  assert.equal(session.count, 3);
  assert.deepEqual(session.list(), [shot(1), shot(2), shot(3)]);
});

test('an invalid max falls back to the default cap', () => {
  assert.equal(createCaptureSession({ max: 0 }).max, MAX_SHOTS);
  assert.equal(createCaptureSession({ max: -4 }).max, MAX_SHOTS);
  assert.equal(createCaptureSession({ max: 'lots' }).max, MAX_SHOTS);
});

test('clear empties the session and reports whether there was anything to clear', () => {
  const session = createCaptureSession();
  assert.equal(session.clear(), false, 'clearing an empty session is a no-op');
  session.add(shot(1));
  assert.equal(session.clear(), true);
  assert.equal(session.count, 0);
  assert.deepEqual(session.list(), []);
});

test('list returns a copy, so a caller cannot mutate the session', () => {
  const session = createCaptureSession();
  session.add(shot(1));
  const taken = session.list();
  taken.push(shot(2));
  assert.equal(session.count, 1);
});
