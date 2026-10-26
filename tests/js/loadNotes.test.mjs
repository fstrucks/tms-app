// Load notes box + Export review refresh (Taylor's QA of #153). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canEditLoadNotes, saveLoadNotes, LOAD_NOTES_MAX } from '../../app/lib/loadNotes.js';
import { exportOptions } from '../../app/lib/loadExport.js';

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const fakeRpc = (reply) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); return reply(args); } }; };

test('who can edit load notes: owner, management, dispatcher; not drivers', () => {
  assert.equal(canEditLoadNotes({ viewer_role: null }), true);
  assert.equal(canEditLoadNotes({ viewer_role: 'owner' }), true);
  assert.equal(canEditLoadNotes({ viewer_role: 'management' }), true);
  assert.equal(canEditLoadNotes({ viewer_role: 'dispatcher' }), true);
  assert.equal(canEditLoadNotes({ viewer_role: 'driver' }), false);
  assert.equal(canEditLoadNotes(null), false);
});

test('Save goes through the existing dispatch_update_load path with only { notes }', async () => {
  const sb = fakeRpc((a) => ({ data: { id: 'L1', notes: a.p_patch.notes }, error: null }));
  const r = await saveLoadNotes(sb, 'L1', '  Gate code 1234 (FAKE)  ');
  assert.deepEqual(r, { ok: true, notes: 'Gate code 1234 (FAKE)' });
  assert.deepEqual(sb.calls, [{ fn: 'dispatch_update_load', args: { p_load: 'L1', p_patch: { notes: 'Gate code 1234 (FAKE)' } } }]);
  const clear = await saveLoadNotes(fakeRpc(() => ({ data: { notes: null }, error: null })), 'L1', '   ');
  assert.deepEqual(clear, { ok: true, notes: null });
});

test('refusals: driver (not_allowed) and too long', async () => {
  const r = await saveLoadNotes(fakeRpc(() => ({ data: null, error: { message: 'not_allowed' } })), 'L1', 'x');
  assert.equal(r.ok, false); assert.match(r.error, /management and dispatchers/);
  const sb = fakeRpc(() => ({ data: null, error: null }));
  const long = await saveLoadNotes(sb, 'L1', 'x'.repeat(LOAD_NOTES_MAX + 1));
  assert.equal(long.ok, false); assert.equal(sb.calls.length, 0);
});

test('once notes exist, "Print the load’s notes" is offered', () => {
  const base = { id: 'L1', status: 'delivered', stops: [] };
  assert.equal(exportOptions({ load: { ...base, notes: '' }, docs: [] }).loadNotes.available, false);
  assert.equal(exportOptions({ load: { ...base, notes: 'Lumper paid (FAKE)' }, docs: [] }).loadNotes.available, true);
});

test('load page wiring: notes box with an explicit Save; Export refreshes on notes and checklist changes', () => {
  const page = src('app/loads/[id]/page.js');
  assert.match(page, /<LoadNotes supabase=\{supabase\} load=\{load\}/);
  const box = src('app/components/LoadNotes.js');
  assert.match(box, /if \(!canEditLoadNotes\(load\)\) return null;/);
  assert.match(box, /type="submit" data-testid="load-notes-save"/);
  assert.doesNotMatch(box, /onBlur|setTimeout/); // no autosave
  assert.doesNotMatch(box, /\b(bot|AI|assistant)\b/);
  const ex = src('app/components/LoadExport.js');
  assert.match(ex, /useEffect\(\(\) => \{ setInfo\(null\); setReview\(null\); \}, \[load\?\.notes\]\);/);
  assert.match(ex, /useEffect\(\(\) => \{ setReview\(null\); setSendErr\(null\); \}, \[sel\]\);/);
  assert.ok(ex.indexOf('[sel]);') < ex.indexOf('if (!visible) return null;'), 'hooks run before the early return');
});
