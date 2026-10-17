import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultCoiDraft, syncBody, editBody, resetBody } from '../../app/lib/coiTemplate.js';
import { defaultCoiDraft as reexported } from '../../app/lib/coiRequest.js';

const ctx = { packet: { subject: 'Setup packet (FAKE)' }, profile: { legal_name: 'Test Trucking LLC (FAKE)', mc_number: '000000' }, agent: { name: 'Pat Agent' } };
const tpl = (holder = {}, loadDate = null) => defaultCoiDraft({ ...ctx, certHolder: holder, loadDate });

test('template builder: holder name/address and load date in body; placeholder when empty', () => {
  const a = tpl({ name: 'Test Broker LLC (FAKE)', address: '1 Fake St\nTestville, CA' }, '2026-10-20');
  assert.match(a.body, /Certificate holder:\nTest Broker LLC \(FAKE\)\n1 Fake St\nTestville, CA\n/);
  assert.match(a.body, /in force on 2026-10-20/);
  assert.match(a.body, /Hi Pat,/);
  const b = tpl({});
  assert.match(b.body, /\[broker name and address\]/); assert.doesNotMatch(b.body, /in force on/);
  assert.equal(reexported, defaultCoiDraft);
});

test('dirty tracking: follows template until hand-edited; reset restores and resumes', () => {
  let s = { body: tpl({ name: 'B' }).body, bodyDirty: false };
  s = syncBody(s, tpl({ name: 'B', address: '1 Fake St' }));
  assert.match(s.body, /B\n1 Fake St/); assert.equal(s.bodyDirty, false);
  const t1 = tpl({ name: 'B', address: '1 Fake St' });
  s = editBody(s, s.body + '\nPS: rush please (FAKE)', t1);
  assert.equal(s.bodyDirty, true);
  const t2 = tpl({ name: 'B', address: '1 Fake St' }, '2026-10-20');
  const kept = syncBody(s, t2);
  assert.equal(kept.body, s.body); assert.match(kept.body, /rush please/); assert.doesNotMatch(kept.body, /2026-10-20/);
  // Typing it back to exactly the template counts as not dirty.
  assert.equal(editBody(s, t1.body, t1).bodyDirty, false);
  s = resetBody(kept, t2);
  assert.equal(s.bodyDirty, false); assert.equal(s.body, t2.body);
  assert.match(syncBody(s, tpl({ name: 'C' }, '2026-10-20')).body, /C\n/);
});

test('wiring: panel rebuilds body from holder/load date, Reset to template link; route sends draftContext', () => {
  const ui = readFileSync(new URL('../../app/packets/PacketCoiRequest.js', import.meta.url), 'utf8');
  assert.match(ui, /syncBody\(x, template\)/); assert.match(ui, /editBody\(d, e\.target\.value, template\)/);
  assert.match(ui, /Reset to template/); assert.match(ui, /resetBody\(d, template\)/);
  const r = readFileSync(new URL('../../app/api/packets/[id]/coi-request/route.js', import.meta.url), 'utf8');
  assert.match(r, /draftContext: \{ packet:/);
});
