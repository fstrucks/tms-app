// Home card Rate con button: pick the newest visible rate con and open it the same way the load page does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestRateCon, visibleDocsFor } from '../../app/lib/loadDocs.js';
import { openLoadDoc } from '../../app/lib/loadDocsClient.js';

const rc = (id, created_at, extra = {}) => ({ id, doc_type: 'rate_confirmation', created_at, file_path: `${id}.pdf`, ...extra });

test('latestRateCon: none, one, or the most recent of several (created_at, then id)', () => {
  assert.equal(latestRateCon(null), null);
  assert.equal(latestRateCon([]), null);
  assert.equal(latestRateCon([{ doc_type: 'bol', created_at: '2026-11-26T12:00:00Z' }]), null);
  const one = rc('a', '2026-11-20T00:00:00Z');
  assert.equal(latestRateCon([one]), one);
  const older = rc('old', '2026-11-01T00:00:00Z');
  const newer = rc('new', '2026-11-25T18:00:00Z');
  const mid = rc('mid', '2026-11-10T00:00:00Z');
  assert.equal(latestRateCon([older, mid, { doc_type: 'bol', created_at: '2026-11-26T00:00:00Z' }, newer]).id, 'new');
  // Unsorted input still picks the newest.
  assert.equal(latestRateCon([newer, older, mid]).id, 'new');
  const tieA = rc('aaa', '2026-11-25T00:00:00Z');
  const tieB = rc('bbb', '2026-11-25T00:00:00Z');
  assert.equal(latestRateCon([tieA, tieB]).id, 'bbb');
});

test('latestRateCon after visibleDocsFor: a driver without Show rate sees no rate con', () => {
  const load = { assigned_driver_user_id: 'drv', show_rate_to_driver: false };
  const docs = [rc('rc1', '2026-11-25T00:00:00Z'), { doc_type: 'bol', created_at: '2026-11-24T00:00:00Z' }];
  assert.equal(latestRateCon(visibleDocsFor('driver', load, 'drv', docs)), null);
  assert.equal(latestRateCon(visibleDocsFor('driver', { ...load, show_rate_to_driver: true }, 'drv', docs)).id, 'rc1');
  assert.equal(latestRateCon(visibleDocsFor('owner', load, 'own', docs)).id, 'rc1');
  assert.equal(latestRateCon(visibleDocsFor('dispatcher', load, 'disp', docs)).id, 'rc1');
});

test('openLoadDoc: prefers the signed URL from the documents API; falls back to createSignedUrl for own files', async () => {
  const opened = [];
  const open = (url) => opened.push(url);
  const signed = { url: 'https://signed.example/rc.pdf', file_path: 'own/rc.pdf', doc_type: 'rate_confirmation' };
  assert.deepEqual(await openLoadDoc({}, signed, { open }), { ok: true });
  assert.deepEqual(opened, ['https://signed.example/rc.pdf']);

  opened.length = 0;
  const sb = { storage: { from: (bucket) => {
    assert.equal(bucket, 'documents');
    return { createSignedUrl: async (path, sec) => {
      assert.equal(path, 'own/rc.pdf');
      assert.equal(sec, 300);
      return { data: { signedUrl: 'https://fallback.example/rc.pdf' }, error: null };
    } };
  } } };
  assert.deepEqual(await openLoadDoc(sb, { file_path: 'own/rc.pdf' }, { open }), { ok: true });
  assert.deepEqual(opened, ['https://fallback.example/rc.pdf']);

  opened.length = 0;
  const fail = { storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: 'denied' } }) }) } };
  const r = await openLoadDoc(fail, { file_path: 'x.pdf' }, { open });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'denied');
  assert.deepEqual(opened, []);

  assert.deepEqual(await openLoadDoc({}, null, { open }), { ok: false });
  assert.deepEqual(await openLoadDoc({}, { doc_type: 'rate_confirmation' }, { open }), { ok: false });
});
