import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formToNewLoad, formToPatch } from '../../app/lib/dispatch.js';
const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('New load: broker required (client-side)', () => {
  const r = formToNewLoad({ rate: '1000', broker_name: '  ' });
  assert.equal(r.load, null); assert.equal(r.errors.broker_name, 'Enter the broker.');
  assert.ok(formToNewLoad({ rate: '1000', broker_name: 'Demo Broker (FAKE)' }).load);
  assert.match(read('app/dispatch/new/page.js'), /<Field label="Broker" required/);
});

test('Edit load: show rate disabled/forced off without a driver', () => {
  const page = read('app/dispatch/[id]/page.js');
  assert.match(page, /disabled=\{!form\.assigned_driver_user_id\}/);
  const { patch } = formToPatch({ rate: '1', show_rate_to_driver: true, assigned_driver_user_id: '' }, { rate: 1, show_rate_to_driver: true, assigned_driver_user_id: 'd' });
  assert.equal(patch.show_rate_to_driver, false);
});

test('Home: miles-source note ("typed") is owner-only, so it never runs into the driver rate chip', () => {
  const c = read('app/components/HomeCurrentLoad.js');
  assert.match(c, /const src = miles && owner \? milesSourceNote\(\{ load \}\) : null;/);
  assert.match(c, /marginTop: 12, display: 'flex', flexWrap: 'wrap'/);
});

test('/dispatch/new: sticky Create bar clears the floating Report a bug button', () => {
  assert.match(read('app/dispatch/new/page.js'), /bottom: 'calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\) \+ 60px\)'/);
});
