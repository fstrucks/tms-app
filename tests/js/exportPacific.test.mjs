// Pacific export (Taylor's retest of #153): the real export route with &tz=America/Los_Angeles must print every
// stop time and the Prepared line in Pacific time, with one "All times in PDT (America/Los_Angeles)." line.
// Fake data only; nothing is emailed.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { fakeSupabase } from './fakeSupabase.mjs';
import * as EXPORT from '../../app/api/loads/[id]/export/route.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1', L1 = '00000000-0000-4000-8000-0000000000b1';
function deps(stops) {
  const svc = fakeSupabase({ tables: {
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }], invoices: [], brokers: [], factors: [], stop_delays: [], documents: [],
    loads: [{ id: L1, user_id: OWNER, status: 'delivered', rate: 990, broker_name: 'Fake Broker', broker_load_number: 'TEST-PAC', stops }],
  } });
  svc.storage.from = () => ({ download: async () => ({ data: null }) });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: OWNER } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? 'owner' : null, error: null }) };
  return { mkUserClient: () => uc, sb: svc };
}
// Text drawn by pdf-lib: inflate each content stream, decode the <hex> Tj strings.
function pdfText(buf) {
  const s = Buffer.from(buf).toString('latin1'); let out = '';
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body; try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { body = m[1]; }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += Buffer.from(t[1], 'hex').toString('latin1') + '\n';
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out += t[1] + '\n';
  }
  return out;
}
async function sheet(stops, now) {
  mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  try {
    const r = await EXPORT.GET(new Request('http://x/api?download=1&invoice=0&docs=&stopTimes=1&tz=America%2FLos_Angeles', { headers: { authorization: 'Bearer t' } }), { params: { id: L1 }, deps: deps(stops) });
    assert.equal(r.status, 200);
    return pdfText(await r.arrayBuffer());
  } finally { mock.timers.reset(); }
}
const stop = (id, seq, type, a, c, extra = {}) => ({ id, sequence: seq, stop_type: type, company_name: `Fake ${type}`, arrived_at: a, completed_at: c, ...extra });

test('summer: every stop time and the Prepared line are PDT; zone line names America/Los_Angeles', async () => {
  // Stops in Texas and Illinois on purpose: the packet still prints Pacific, the zone the export asked for.
  const t = await sheet([stop('s1', 1, 'pickup', '2026-10-20T14:00:00Z', '2026-10-20T15:00:00Z', { state: 'TX' }), stop('s2', 2, 'delivery', '2026-10-21T19:30:00Z', '2026-10-21T20:10:00Z', { state: 'IL' })], '2026-10-25T18:00:00Z');
  assert.match(t, /All times in PDT \(America\/Los_Angeles\)\./);
  assert.match(t, /Prepared [^\n]*11:00 AM PDT/, t);
  assert.match(t, /7:00 AM PDT/); assert.match(t, /8:00 AM PDT/); assert.match(t, /12:30 PM PDT/); assert.match(t, /1:10 PM PDT/);
  assert.doesNotMatch(t, /\b(CDT|CST|EDT|EST|MDT|MST|UTC|PST)\b/, 'no other zone on the sheet');
});

test('winter: same export in January prints PST', async () => {
  const t = await sheet([stop('s1', 1, 'pickup', '2027-01-12T16:00:00Z', '2027-01-12T17:15:00Z', { state: 'TX' })], '2027-01-14T20:00:00Z');
  assert.match(t, /All times in PST \(America\/Los_Angeles\)\./);
  assert.match(t, /Prepared [^\n]*12:00 PM PST/, t);
  assert.match(t, /8:00 AM PST/); assert.match(t, /9:15 AM PST/);
  assert.doesNotMatch(t, /\bPDT\b/);
});
