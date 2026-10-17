// fix/broker-packet-cc: every carrier packet emailed to a broker is copied to PACKET_CC_EMAIL (default
// marc@fstrucks.com). FAKE data only; Postmark is always a mock here, nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSend, packetCcEmail, allowedDomains, DEFAULT_PACKET_CC } from '../../app/lib/packetSend.js';
import { autoCcFor } from '../../app/lib/packetSendClient.js';
import { GET, POST } from '../../app/api/packets/[id]/send/route.js';

const OK = { to: 'dispatch@fstrucks.com', cc: '', subject: 'Packet (FAKE)', body: 'Hi (FAKE)', confirm: true };

test('CC added: default marc@fstrucks.com when PACKET_CC_EMAIL is unset or empty', () => {
  assert.equal(DEFAULT_PACKET_CC, 'marc@fstrucks.com');
  assert.equal(packetCcEmail({}), 'marc@fstrucks.com');
  assert.equal(packetCcEmail({ PACKET_CC_EMAIL: '  ' }), 'marc@fstrucks.com');
  const v = validateSend(OK, {});
  assert.deepEqual(v.to, ['dispatch@fstrucks.com']); assert.deepEqual(v.cc, ['marc@fstrucks.com']); assert.equal(v.autoCc, 'marc@fstrucks.com');
  assert.deepEqual(validateSend({ ...OK, cc: 'ops@fstrucks.com' }, {}).cc, ['ops@fstrucks.com', 'marc@fstrucks.com']);
});

test('CC deduped: never duplicates a To address or a typed CC (case-insensitive)', () => {
  const t = validateSend({ ...OK, to: 'dispatch@fstrucks.com, MARC@FSTRUCKS.COM' }, {});
  assert.deepEqual(t.to, ['dispatch@fstrucks.com', 'marc@fstrucks.com']); assert.deepEqual(t.cc, []); assert.equal(t.autoCc, null);
  assert.deepEqual(validateSend({ ...OK, to: 'Marc@FSTrucks.com' }, {}).cc, []); // Reply-To = To = marc@: no extra copy
  assert.deepEqual(validateSend({ ...OK, cc: 'Marc@fstrucks.com' }, {}).cc, ['marc@fstrucks.com']); // typed + automatic → once
  assert.equal(autoCcFor('marc@fstrucks.com', ['MARC@fstrucks.com ']), null);
  assert.equal(autoCcFor(' Marc@fstrucks.com', ['a@fstrucks.com']), 'marc@fstrucks.com');
  assert.equal(autoCcFor(null, ['a@fstrucks.com']), null);
});

test('env override: PACKET_CC_EMAIL replaces the default; none/off disables; invalid → no copy', () => {
  assert.equal(packetCcEmail({ PACKET_CC_EMAIL: 'Office@FStrucks.com' }), 'office@fstrucks.com');
  assert.deepEqual(validateSend(OK, { PACKET_CC_EMAIL: 'office@fstrucks.com' }).cc, ['office@fstrucks.com']);
  assert.equal(packetCcEmail({ PACKET_CC_EMAIL: 'none' }), null); assert.equal(packetCcEmail({ PACKET_CC_EMAIL: 'OFF' }), null);
  assert.deepEqual(validateSend(OK, { PACKET_CC_EMAIL: 'none' }).cc, []);
  const err = console.error; console.error = () => {};
  try { assert.equal(packetCcEmail({ PACKET_CC_EMAIL: 'not an email' }), null); } finally { console.error = err; }
});

test('limit unchanged: fstrucks.com-only still blocks typed outside addresses; the automatic copy is never blocked or listed', () => {
  assert.deepEqual(allowedDomains({}), ['fstrucks.com']);
  const r = validateSend({ ...OK, to: 'broker@outside.example' }, {});
  assert.equal(r.status, 403); assert.deepEqual(r.blocked, ['broker@outside.example']);
  assert.equal(validateSend({ ...OK, cc: 'cc@other.example' }, {}).status, 403);
  // The copy goes out even when its address isn't in the allowed list (the limit applies to what the user typed).
  const v = validateSend(OK, { PACKET_SEND_ALLOWED_DOMAINS: 'fstrucks.com', PACKET_CC_EMAIL: 'copy@elsewhere.example' });
  assert.equal(v.error, undefined); assert.deepEqual(v.cc, ['copy@elsewhere.example']);
  assert.equal(allowedDomains({ PACKET_SEND_ALLOWED_DOMAINS: '*' }), null);
  assert.deepEqual(validateSend({ ...OK, to: 'broker@outside.example' }, { PACKET_SEND_ALLOWED_DOMAINS: '*' }).cc, ['marc@fstrucks.com']);
});

// ---- route: mock Postmark + in-memory packet_sends ----
const PID = '00000000-0000-4000-8000-0000000000c7';
const KEY = '11111111-2222-4333-8444-555555555555';
function memSb() {
  const tbl = { packets: [{ id: PID, owner_id: 'owner1', status: 'review', original_filename: 'Broker Packet (FAKE).pdf', filled_path: 'owner1/packets/filled/c.pdf' }], packet_sends: [], company_profiles: [{ owner_id: 'owner1', legal_name: 'Test Trucking (FAKE)' }], coi_requests: [] };
  const from = (name) => {
    const st = { f: [], op: 'select' };
    const run = () => {
      const rows = (tbl[name] || []).filter((r) => st.f.every(([k, v]) => r[k] === v));
      if (st.op === 'insert') { tbl[name].push({ ...st.payload }); return { data: null, error: null }; }
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: null, error: null }; }
      if (st.op === 'delete') { tbl[name] = tbl[name].filter((r) => !rows.includes(r)); return { data: null, error: null }; }
      return { data: st.one ? rows[0] || null : rows, error: null, count: rows.length };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, gte() { return b; }, lt() { return b; }, order() { return b; }, limit() { return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; }, update(p) { st.op = 'update'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, single: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) };
    return b;
  };
  return { tbl, from, storage: { from: () => ({ download: async (p) => (p === 'owner1/packets/filled/c.pdf' ? { data: new Blob([Buffer.from('%PDF fake')]) } : { data: null }) }) } };
}
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async () => ({ data: role }) });
const req = (body, method = 'POST') => new Request(`http://x/api/packets/${PID}/send`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('route: the copy goes in Postmark Cc and is recorded in packet_sends.cc_emails; GET tells the sheet who gets it', async () => {
  const sb = memSb(); const calls = [];
  const fetch = async (u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-cc-1' }), { status: 200 }); };
  const env = { POSTMARK_SERVER_TOKEN: 'fake-token-for-tests' };
  const g = await (await GET(req(null, 'GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env } })).json();
  assert.equal(g.autoCc, 'marc@fstrucks.com');
  const r = await POST(req({ ...OK, idempotencyKey: KEY }), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env, fetch } });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0].To, 'dispatch@fstrucks.com'); assert.equal(calls[0].Cc, 'marc@fstrucks.com');
  assert.deepEqual(sb.tbl.packet_sends[0].cc_emails, ['marc@fstrucks.com']);
  const j = await r.json(); assert.deepEqual(j.sends[0].cc, ['marc@fstrucks.com']); // sent history shows "(cc marc@fstrucks.com)"
});

test('send sheet shows "A copy goes to …" and the review CC includes it', () => {
  const src = readFileSync('app/packets/PacketSendBroker.js', 'utf8');
  assert.match(src, /const copyTo = autoCcFor\(info\.autoCc, list\(d\.to\)\)/);
  assert.match(src, /A copy goes to \{copyTo\}\./);
  assert.match(src, /reviewCc\.join\(', '\)/);
  assert.match(src, /\(cc \$\{s\.cc\.join\(', '\)\}\)/); // history already lists CCs
});
