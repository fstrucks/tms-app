import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDelayNote, delayNoteHint, NOTE_MAX } from '../../app/lib/stopDelays.js';

test('delay note: cut at 300 with a message; counter near the limit', () => {
  assert.deepEqual(clipDelayNote('a'.repeat(310)), { note: 'a'.repeat(NOTE_MAX), cut: true });
  assert.deepEqual(clipDelayNote('hi'), { note: 'hi', cut: false });
  assert.equal(delayNoteHint(300, true), '300/300. Extra text was cut.');
  assert.equal(delayNoteHint(260, false), '260/300');
  assert.equal(delayNoteHint(10, false), null);
});
