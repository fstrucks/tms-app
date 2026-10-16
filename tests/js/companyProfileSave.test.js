import test from 'node:test';
import assert from 'node:assert/strict';
import { saveProfile, saveErrorMessage } from '../../app/lib/companyProfileSave.js';

function fakeSb(log) {
  const q = (table) => {
    const st = { table, ops: [] };
    const api = {
      insert(r) { st.ops.push('insert'); const p = Promise.resolve({ data: null, error: null }); p.select = () => { st.ops.push('returning'); return { single: async () => ({ error: { code: '42501' } }) }; }; log.push(st); return p; },
      select() { st.ops.push('select'); return api; },
      eq() { return api; },
      single: async () => { log.push(st); return { data: { id: 'p1', owner_id: 'u1' }, error: null }; },
    };
    return api;
  };
  return { from: q };
}

test('first save inserts without RETURNING then re-reads', async () => {
  const log = [];
  const { data, error } = await saveProfile({ sb: fakeSb(log), user: { id: 'u1' }, profile: null }, { legal_name: 'X' });
  assert.equal(error, null);
  assert.equal(data.id, 'p1');
  assert.ok(!log.some((s) => s.ops.includes('returning')));
});

test('config/db errors map to clear messages', () => {
  assert.match(saveErrorMessage({ code: '42501' }), /policy/);
  assert.match(saveErrorMessage({ code: 'PGRST204' }), /migration/);
  assert.equal(saveErrorMessage({}), 'Could not save the company profile.');
});
