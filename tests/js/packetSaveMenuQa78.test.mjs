// QA #78 follow-up: (a) false "Network problem" on a save that went through + duplicate field after reload;
// (b) owner-only account menu items missing on the packet editor. Fake test data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDraft, saveDraft, loadDraft, applyDraft, draftKey, reconcileWithServer, sameAsServer, saveOutcomeUnknown } from '../../app/lib/packetDraft.js';
import { saveFields, saveErrorText } from '../../app/lib/packetSave.js';
import { buildPatch } from '../../app/lib/packetMapperModel.js';
import { PATCH } from '../../app/api/packets/[id]/fields/route.js';
import { companyOwnerStatus, clearOwnerCache, accountMenuItems, ACCOUNT_MENU_ORDER } from '../../app/lib/accountOwner.js';

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const PID = '11111111-2222-4333-8444-555555555555';
function mem() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; }
const srvRow = (o) => ({ id: 'srv-1', field_key: 'u-abc123', page: 1, kind: 'text', label: '', box: [100.4, 200, 400, 240], profile_key: 'legal_name', value: '', confirmed: false, sensitive: false, ...o });
const tmpField = (o) => ({ id: 'tmp-abc123', field_key: 'u-abc123', page: 1, kind: 'text', label: '', box: [100.43, 200, 400, 240], profile_key: 'legal_name', value: '', confirmed: false, dirty: true, source: 'user', ...o });

// ---------- (a) draft reconcile: no duplicate, no false "Restored"
test('a: restore after a save that went through (reply lost): no duplicate field, nothing "restored"', () => {
  const st = mem();
  saveDraft(st, PID, [tmpField()], []);                       // draft left behind by the "failed" save
  const server = [srvRow({ id: 'srv-0', field_key: 'f-legal' }), srvRow()]; // ...but the server has the new field
  const r = applyDraft(server, loadDraft(st, PID));
  assert.equal(r.fields.length, 2, 'the new field is not appended a second time');
  assert.equal(r.fields.filter((f) => f.field_key === 'u-abc123').length, 1);
  assert.ok(!r.fields.some((f) => String(f.id).startsWith('tmp-')));
  assert.equal(r.restored, 0, 'no "Restored 1 unsaved change" message');
  assert.equal(r.alreadySaved, 1);
});
test('a: restore keeps edits made after the lost save, merged onto the server row (still one field)', () => {
  const draft = makeDraft([tmpField({ label: 'Carrier name' })], []);
  const r = applyDraft([srvRow()], draft);
  assert.equal(r.fields.length, 1); assert.equal(r.restored, 1);
  assert.equal(r.fields[0].id, 'srv-1'); assert.equal(r.fields[0].label, 'Carrier name'); assert.equal(r.fields[0].dirty, true);
  assert.deepEqual(buildPatch(r.fields, r.deleted).upserts.map((u) => u.id), ['srv-1'], 'next Save updates by id, never inserts again');
});
test('a: a new field the server never got is still restored (once), and draft dupes collapse', () => {
  const r = applyDraft([srvRow({ id: 'srv-0', field_key: 'f-legal' })], makeDraft([tmpField(), tmpField()], []));
  assert.equal(r.fields.length, 2); assert.equal(r.restored, 1);
});
test('a: deletes and edits the server already has are dropped; secrets still never stored', () => {
  const st = mem();
  const fields = [{ ...srvRow({ id: 'e1', field_key: 'k1', box: [1, 1, 9, 9] }), dirty: true }, { ...srvRow({ id: 'b1', field_key: 'k2', profile_key: 'bank_account' }), dirty: true, valueDirty: true, value: '000123456789' }];
  saveDraft(st, PID, fields, ['gone']);
  assert.ok(!st.getItem(draftKey(PID)).includes('000123456789'));
  const r = applyDraft([srvRow({ id: 'e1', field_key: 'k1', box: [1, 1, 9, 9] }), srvRow({ id: 'b1', field_key: 'k2', profile_key: 'bank_account', sensitive: true })], loadDraft(st, PID));
  assert.equal(r.deleted.length, 0); assert.equal(r.restored, 0);
});
test('a: sameAsServer tolerates server rounding, catches real differences', () => {
  assert.equal(sameAsServer(tmpField(), srvRow()), true);
  assert.equal(sameAsServer(tmpField({ box: [110, 200, 400, 240] }), srvRow()), false);
  assert.equal(sameAsServer(tmpField({ valueDirty: true, value: 'Fake Co' }), srvRow({ value: 'Fake Co' })), true);
  assert.equal(sameAsServer(tmpField({ valueDirty: true, value: 'Fake Co' }), srvRow({ value: '' })), false);
  assert.equal(sameAsServer(tmpField({ profile_key: 'ein', valueDirty: true, value: '00-0000000' }), srvRow({ profile_key: 'ein', sensitive: true })), false);
});
test('a: which replies are checked against the server', () => {
  assert.equal(saveOutcomeUnknown({ error: 'Network problem. Check your connection and try again.', status: 0 }), true);
  assert.equal(saveOutcomeUnknown({ error: 'Something went wrong.', status: 504 }), true);
  assert.equal(saveOutcomeUnknown({}), true); // 2xx without the list
  assert.equal(saveOutcomeUnknown({ ok: true, errors: [], fields: [] }), false);
  assert.equal(saveOutcomeUnknown({ error: 'Type a name', status: 400 }), false);
});

// ---------- (a) save flow
const noSleep = async () => {};
test('a: reply lost but the server saved → "saved" (no error shown), draft can be cleared', async () => {
  const dirty = [tmpField()];
  const out = await saveFields({ save: async () => ({ error: 'Network problem. Check your connection and try again.', status: 0 }), reload: async () => ({ fields: [srvRow()] }), patch: buildPatch(dirty, []), dirty, sleep: noSleep });
  assert.equal(out.kind, 'saved'); assert.equal(out.verified, true); assert.equal(out.res.error, undefined);
  assert.deepEqual(out.fields.map((f) => f.id), ['srv-1']);
});
test('a: reply lost and the server is still writing → checks again, then "saved"', async () => {
  const dirty = [tmpField()]; let n = 0;
  const out = await saveFields({ save: async () => ({ status: 0, error: 'Network problem.' }), reload: async () => (++n === 1 ? { fields: [] } : { fields: [srvRow()] }), patch: {}, dirty, sleep: noSleep });
  assert.equal(out.kind, 'saved'); assert.equal(n, 2);
});
test('a: really not saved → error, edits kept; a partly-saved new field is rebased to its server id', async () => {
  const dirty = [tmpField({ label: 'Changed after' }), tmpField({ id: 'tmp-zz', field_key: 'u-zz' })];
  const out = await saveFields({ save: async () => ({ status: 0, error: 'Network problem.' }), reload: async () => ({ fields: [srvRow()] }), patch: {}, dirty, sleep: noSleep });
  assert.equal(out.kind, 'error'); assert.equal(out.pending, 2);
  assert.deepEqual(out.fields.map((f) => f.id), ['srv-1', 'tmp-zz']);
  const p = buildPatch(out.fields, out.deleted);
  assert.equal(p.upserts.find((u) => u.label === 'Changed after').id, 'srv-1');
  assert.match(saveErrorText(out.res), /Network problem: not saved\. Your changes are still here/);
});
test('a: a clean success never touches the error path; signed out stays signed out', async () => {
  let reloads = 0;
  const ok = await saveFields({ save: async () => ({ ok: true, errors: [], fields: [srvRow()] }), reload: async () => { reloads++; return {}; }, patch: {}, dirty: [tmpField()], sleep: noSleep });
  assert.equal(ok.kind, 'saved'); assert.equal(reloads, 0);
  const so = await saveFields({ save: async () => ({ signedOut: true, error: 'x', status: 401 }), reload: async () => ({}), patch: {}, dirty: [], sleep: noSleep });
  assert.equal(so.kind, 'signedOut');
  const bad = await saveFields({ save: async () => ({ error: 'Type a name for the custom field', status: 400 }), reload: async () => { reloads++; return {}; }, patch: {}, dirty: [], sleep: noSleep });
  assert.equal(bad.kind, 'error'); assert.equal(reloads, 0);
});

// ---------- (a) server: PATCH idempotent on field_key, always JSON
function fakeSb(rows) {
  const ops = [];
  const from = (t) => {
    const st = { t, op: 'select', filters: [], row: null };
    const run = async () => {
      if (st.t === 'packets') return { data: { id: PID, owner_id: 'owner-fake' }, error: null };
      if (st.op === 'insert') { if (rows.some((r) => r.field_key === st.row.field_key)) return { error: { code: '23505' } }; rows.push({ id: `row-${rows.length + 1}`, ...st.row }); ops.push('insert'); return { error: null }; }
      if (st.op === 'update') { const id = st.filters.find((f) => f[0] === 'id')[1]; const r = rows.find((x) => x.id === id); Object.assign(r, st.row); ops.push(`update:${id}`); return { error: null }; }
      if (st.op === 'delete') { ops.push('delete'); return { error: null }; }
      if (fakeSb.failList && st.op === 'select' && ops.length) return { data: null, error: { code: 'XX000', message: 'boom' } };
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const q = {
      select() { return q; }, eq(k, v) { st.filters.push([k, v]); return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle: run, insert(r) { st.op = 'insert'; st.row = r; return q; }, update(r) { st.op = 'update'; st.row = r; return q; }, delete() { st.op = 'delete'; return q; },
      then(a, b) { return run().then(a, b); },
    };
    return q;
  };
  return { sb: { from }, ops };
}
const deps = (sb) => ({ sb, mkUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-fake' } }, error: null }) }, rpc: async () => ({ data: 'owner', error: null }) }) });
const patchReq = (body) => new Request(`http://x/api/packets/${PID}/fields`, { method: 'PATCH', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const newField = { field_key: 'u-abc123', page: 1, kind: 'text', label: '', box: [100, 200, 400, 240], profile_key: 'legal_name', page_w: 1700, page_h: 2200 };
test('a: retried save of a new field (first reply lost) updates the same row: one field, no "Save failed"', async () => {
  const rows = []; const { sb, ops } = fakeSb(rows);
  let r = await PATCH(patchReq({ upserts: [newField], deletes: [] }), { params: { id: PID }, deps: deps(sb) });
  assert.equal(r.status, 200);
  r = await PATCH(patchReq({ upserts: [newField], deletes: [] }), { params: { id: PID }, deps: deps(sb) }); // the retry
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.deepEqual(j.errors, []);
  assert.equal(rows.filter((x) => x.field_key === 'u-abc123').length, 1);
  assert.deepEqual(ops, ['insert', `update:${rows[0].id}`]);
  assert.equal(j.fields.length, 1);
});
test('a: the same new field twice in one request is written once', async () => {
  const rows = []; const { sb } = fakeSb(rows);
  const r = await PATCH(patchReq({ upserts: [newField, { ...newField, label: 'Second copy' }] }), { params: { id: PID }, deps: deps(sb) });
  assert.equal(r.status, 200); assert.equal(rows.length, 1); assert.equal(rows[0].label, 'Second copy');
});
test('a: edits written but the fresh list fails → 200 + reload (not an error); a crash is still JSON', async () => {
  const rows = []; const { sb } = fakeSb(rows);
  fakeSb.failList = true;
  try {
    const r = await PATCH(patchReq({ upserts: [newField] }), { params: { id: PID }, deps: deps(sb) });
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.reload, true); assert.equal(rows.length, 1);
    assert.equal(saveOutcomeUnknown(j), true, 'client then checks the server instead of trusting a missing list');
  } finally { fakeSb.failList = false; }
  const boom = { from: () => { throw new Error('unexpected'); } };
  const r2 = await PATCH(patchReq({ upserts: [newField] }), { params: { id: PID }, deps: deps(boom) });
  assert.equal(r2.status, 500); assert.match(r2.headers.get('content-type') || '', /json/);
});
test('a: editor wiring: save goes through saveFields with a server reload; new ids are unique', () => {
  const m = src('app/packets/PacketMapper.js');
  assert.match(m, /await saveFields\(\{ save: onSave, reload,/);
  assert.match(m, /if \(store\) clearDraft\(store, packet\.id\); \/\/ the server confirmed the save/);
  assert.match(m, /tmp-\$\{Date\.now\(\)\.toString\(36\)\}\$\{Math\.random\(\)/);
  assert.match(src('app/packets/[id]/page.js'), /onReload=\{onReload\}/);
});

// ---------- (b) account menu: same items, same order, on every page
function fakeClient({ session = { access_token: 't', user: { id: 'owner-a' } }, rows = [{ id: 'p' }], error = null, onQuery } = {}) {
  return { auth: { getSession: async () => ({ data: { session } }) },
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => { onQuery?.(); return { data: rows, error }; } }) }) }) };
}
test('b: owner check never says "not owner" without a session (anon RLS read returns [] silently)', async () => {
  clearOwnerCache(); let queried = 0;
  assert.deepEqual(await companyOwnerStatus(fakeClient({ session: null, rows: [], onQuery: () => queried++ }), 'owner-a'), { owner: false, definite: false });
  assert.equal(queried, 0, 'no query goes out with the anon key');
  assert.deepEqual(await companyOwnerStatus(fakeClient({ error: { code: 'PGRST301' } }), 'owner-a'), { owner: false, definite: false });
  assert.deepEqual(await companyOwnerStatus(fakeClient({ session: { access_token: 't', user: { id: 'someone-else' } } }), 'owner-a'), { owner: false, definite: false });
});
test('b: positives are cached, negatives are re-checked (a stale false can no longer stick for the tab)', async () => {
  clearOwnerCache(); let q = 0; const session = { access_token: 't', user: { id: 'u-1' } };
  assert.deepEqual(await companyOwnerStatus(fakeClient({ session, rows: [], onQuery: () => q++ }), 'u-1'), { owner: false, definite: true });
  assert.deepEqual(await companyOwnerStatus(fakeClient({ session, rows: [{ id: 'p' }], onQuery: () => q++ }), 'u-1'), { owner: true, definite: true });
  assert.deepEqual(await companyOwnerStatus(fakeClient({ session, rows: [], onQuery: () => q++ }), 'u-1'), { owner: true, definite: true });
  assert.equal(q, 2);
});
test('b: menu order is Password, Company profile, Invite testers, Bug reports, Carrier packets, Welcome tour, Sign out', () => {
  assert.deepEqual(ACCOUNT_MENU_ORDER, ['Password', 'Company profile', 'Invite testers', 'Bug reports', 'Carrier packets', 'Welcome tour', 'Sign out']);
  assert.deepEqual(accountMenuItems({ owner: false }), ['Password', 'Company profile', 'Carrier packets', 'Welcome tour', 'Sign out']);
  const m = src('app/components/ui/AccountMenu.js');
  const at = { Password: m.indexOf("'Set password'"), 'Company profile': m.indexOf('Company profile\n'), 'Invite testers': m.indexOf('<InviteTestersMenuItem '), 'Bug reports': m.indexOf('<BugReportsMenuItem '), 'Carrier packets': m.indexOf('Carrier packets\n'), 'Welcome tour': m.indexOf('>Welcome tour<'), 'Sign out': m.indexOf("'Sign out'") };
  for (const k of ACCOUNT_MENU_ORDER) assert.ok(at[k] > 0, k);
  const order = [...ACCOUNT_MENU_ORDER].sort((a, b) => at[a] - at[b]);
  assert.deepEqual(order, ACCOUNT_MENU_ORDER);
});
test('b: one menu everywhere: rendered only by AppNav from the root layout; both owner items read one shared answer', () => {
  const nav = src('app/components/AppNav.js');
  assert.equal((src('app/layout.js').match(/<AppNav \/>/g) || []).length, 1);
  assert.equal((nav.match(/<AccountMenu\b/g) || []).length, 2); // desktop top nav + phone top bar, same component
  for (const f of ['app/packets/[id]/page.js', 'app/packets/PacketMapper.js', 'app/packets/page.js']) assert.doesNotMatch(src(f), /AccountMenu|InviteTestersMenuItem|BugReportsMenuItem/, f);
  const m = src('app/components/ui/AccountMenu.js');
  assert.match(m, /<InviteTestersMenuItem owner=\{owner\}/); assert.match(m, /<BugReportsMenuItem owner=\{owner\}/);
  assert.match(m, /checkUntilDefinite\(\(\) => companyOwnerStatus\(supabase, uid\), \(r\) => \{ if \(r\.definite\) setOwner\(r\.owner\); \}\)/);
  assert.match(m, /\[uid, open, authTick\]/); assert.match(m, /TOKEN_REFRESHED/);
  for (const f of ['app/components/BugReportsMenuItem.js', 'app/components/ui/InviteTestersMenuItem.js']) {
    assert.doesNotMatch(src(f), /from\('company_profiles'\)|useEffect/, `${f}: no per-item query`);
  }
});
