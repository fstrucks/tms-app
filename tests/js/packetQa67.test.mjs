// Taylor's #67 QA notes: status chip on the packet page, "Name N fields" status, zone-labelled list times,
// one automatic retry on a network failure at sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packetDisplayStatus, fieldSummary, filterPackets, PACKET_FILTERS, DISPLAY, statusChipStyle, namesLabel } from '../../app/lib/packetStatus.js';
import { summarize } from '../../app/lib/packetMapperModel.js';
import { listPackets, SUMMARY_OR } from '../../app/lib/packetList.js';
import { formatListTime } from '../../app/lib/packetDate.js';
import { signInWithRetry, isNetworkAuthError, NETWORK_SIGNIN_MSG } from '../../app/lib/signInRetry.js';

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const P1 = '00000000-0000-4000-8000-0000000000b1', P2 = '00000000-0000-4000-8000-0000000000b2', P3 = '00000000-0000-4000-8000-0000000000b3';

// --- 2: "Name N fields" -------------------------------------------------------------------------------
test('unnamed fields: "Name N fields" (amber, To do) beats Ready / Signed / Filled; same rule as the badge', () => {
  const fields = [{ profile_key: 'legal_name' }, { profile_key: null }, { profile_key: '' }, { kind: 'text' }, { profile_key: 'mc_number' }, { profile_key: 'phone' }, { profile_key: 'email' }, { profile_key: 'date' }];
  const sum = fieldSummary(fields);
  assert.equal(sum.unnamed, 3);
  assert.equal(sum.unnamed, summarize(fields).unmapped); // the orange "3 need a name" badge
  const d = packetDisplayStatus({ status: 'review' }, sum);
  assert.deepEqual([d.key, d.label], ['needs_names', 'Name 3 fields']);
  assert.match(d.color, /^#[0-9a-f]{6}$/);
  assert.equal(DISPLAY.needs_names.color, '#d97706'); // amber, same as the badge
  assert.equal(namesLabel(1), 'Name 1 field');
  assert.equal(packetDisplayStatus({ status: 'review', filled_at: 'x' }, sum).key, 'needs_names');
  assert.equal(packetDisplayStatus({ status: 'review' }, { ...sum, sigTotal: 1, sigSigned: 0 }).key, 'needs_names');
  // Pipeline / terminal states still win.
  for (const st of ['received', 'processing', 'error', 'archived', 'sent']) assert.equal(packetDisplayStatus({ status: st }, sum).key, st);
  assert.equal(packetDisplayStatus({ status: 'review', sent_at: 'x' }, sum).key, 'sent');
  // Naming them all → Ready again.
  assert.equal(packetDisplayStatus({ status: 'review' }, fieldSummary(fields.map((f, i) => ({ ...f, profile_key: f.profile_key || `k${i}` })))).key, 'ready');
  assert.equal(packetDisplayStatus({ status: 'review' }, { fieldCount: 5, sigTotal: 0, sigSigned: 0 }).key, 'ready'); // older summaries w/o count
  assert.ok(PACKET_FILTERS.find((f) => f.id === 'todo').keys.includes('needs_names'));
  assert.deepEqual(filterPackets([{ display: 'needs_names' }, { display: 'filled' }], 'todo').map((r) => r.display), ['needs_names']);
});

// Minimal service-key fake: records each query; .or() applies the same OR the real query sends.
function fakeSb(tables) {
  const log = [];
  const from = (name) => {
    const st = { name, cols: '', f: [], raw: [] };
    const run = () => {
      log.push(st);
      const rows = (tables[name] || []).filter((r) => st.f.every((fn) => fn(r)));
      if (name === 'packets' && /packet_fields\(count\)/.test(st.cols)) return { data: rows.map((r) => ({ id: r.id, packet_fields: [{ count: tables.packet_fields.filter((f) => f.packet_id === r.id).length }] })), error: null };
      return { data: rows, error: null };
    };
    const b = {
      select(c) { st.cols = c; return b; },
      in(k, vs) { st.raw.push(`${k}=in`); st.f.push((r) => vs.includes(r[k])); return b; },
      or(expr) {
        st.raw.push(`or=${expr}`);
        const parts = expr.split(',').map((p) => p.split('.'));
        st.f.push((r) => parts.some(([k, op, v]) => (op === 'is' ? r[k] == null : r[k] === v)));
        return b;
      },
      then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    };
    return b;
  };
  return { from, log };
}
function fakeUc(packets) {
  const q = { select() { return q; }, order() { return q; }, limit() { return q; }, neq() { return q; }, eq() { return q; }, then: (res) => res({ data: packets, error: null, count: 0 }) };
  return { from: () => q, rpc: async () => ({ data: 'owner' }) };
}

test('list API: unnamed counts come from the existing signature query (no extra round trip, no full field scan)', async () => {
  const packets = [
    { id: P1, owner_id: 'o', status: 'review', created_at: '2026-10-17T16:50:00Z' },
    { id: P2, owner_id: 'o', status: 'review', created_at: '2026-10-17T16:00:00Z' },
    { id: P3, owner_id: 'o', status: 'review', created_at: '2026-10-17T15:00:00Z' },
  ];
  const pf = [
    ...['legal_name', 'mc_number', 'phone', 'email', 'date'].map((k) => ({ packet_id: P1, kind: 'text', profile_key: k })),
    { packet_id: P1, kind: 'text', profile_key: null }, { packet_id: P1, kind: 'text', profile_key: null }, { packet_id: P1, kind: 'text', profile_key: null },
    { packet_id: P2, kind: 'text', profile_key: 'legal_name' }, { packet_id: P2, kind: 'signature', profile_key: 'signature', signature_path: 'o/s.png' },
    { packet_id: P3, kind: 'signature', profile_key: null }, // unnamed signature box: counts as both
  ];
  const sb = fakeSb({ packets, packet_fields: pf });
  const r = await listPackets({ uc: fakeUc(packets), sb });
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.deepEqual([by[P1].display, by[P1].label, by[P1].unnamed, by[P1].fieldCount], ['needs_names', 'Name 3 fields', 3, 8]);
  assert.deepEqual([by[P2].display, by[P2].unnamed], ['signed', 0]);
  assert.deepEqual([by[P3].display, by[P3].label, by[P3].sigTotal], ['needs_names', 'Name 1 field', 1]);
  assert.equal(sb.log.length, 2); // still 2 service queries
  const fq = sb.log.find((q) => q.name === 'packet_fields');
  assert.equal(fq.cols, 'packet_id,kind,profile_key,signature_path'); // no values / ciphertext
  assert.ok(fq.raw.includes(`or=${SUMMARY_OR}`));
  assert.match(SUMMARY_OR, /profile_key\.is\.null/);
});

// --- 1: chip on the packet page -----------------------------------------------------------------------
test('packet page shows the status as the same coloured chip as the list (shared packetStatus.js)', () => {
  const m = src('app/packets/PacketMapper.js'), page = src('app/packets/page.js');
  assert.match(m, /data-testid="packet-status" data-status=\{status\.key\} style=\{statusChipStyle\(status\.color\)\}>\{status\.label\}/);
  assert.match(page, /chip: statusChipStyle/);
  assert.doesNotMatch(m, /'Uploaded'\} · <span data-testid="packet-status"/);
  assert.deepEqual(statusChipStyle('#2563eb'), { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#fff', background: '#2563eb', whiteSpace: 'nowrap' });
});

// --- 3: zone labels ---------------------------------------------------------------------------------
test('list times carry a zone label in the viewer\'s zone', () => {
  assert.equal(formatListTime('2026-10-17T16:50:00Z', 'America/Chicago'), 'Oct 17, 2026, 11:50 AM CDT');
  assert.equal(formatListTime('2026-10-17T16:50:00+00:00', 'America/Los_Angeles'), 'Oct 17, 2026, 9:50 AM PDT');
  assert.equal(formatListTime('2026-10-17 16:50:00', 'America/Los_Angeles'), 'Oct 17, 2026, 9:50 AM PDT'); // bare = UTC
  assert.match(formatListTime('2026-10-17T16:50:00Z'), /[AP]M [A-Z]{2,5}$/); // browser zone (test TZ = LA)
  assert.equal(formatListTime('nope'), '');
  const page = src('app/packets/page.js');
  assert.doesNotMatch(page, /toLocaleString|toLocaleTimeString/);
  assert.match(page, /formatListTime\(r\.created_at\)/);
  assert.match(src('app/packets/PacketMapper.js'), /formatListTime\(packet\.created_at\)/);
});

// --- 4: sign-in retry -------------------------------------------------------------------------------
test('sign-in retries once on a network failure, never on a wrong password', async () => {
  const wait = async () => {};
  const netErr = { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 };
  let n = 0;
  let r = await signInWithRetry(async () => (++n === 1 ? { data: null, error: netErr } : { data: { user: { id: 'u' } }, error: null }), {}, { wait });
  assert.equal(n, 2); assert.equal(r.data.user.id, 'u');
  n = 0;
  r = await signInWithRetry(async () => { if (++n === 1) throw new TypeError('Failed to fetch'); return { data: { user: { id: 'u' } }, error: null }; }, {}, { wait });
  assert.equal(n, 2); assert.equal(r.error, null);
  n = 0;
  r = await signInWithRetry(async () => { n++; return { data: null, error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400 } }; }, {}, { wait });
  assert.equal(n, 1); assert.match(r.error.message, /Invalid/);
  n = 0;
  r = await signInWithRetry(async () => { n++; return { data: null, error: netErr }; }, {}, { wait });
  assert.equal(n, 2); assert.ok(isNetworkAuthError(r.error)); // only one retry
  n = 0;
  await assert.rejects(signInWithRetry(async () => { n++; throw new Error('boom'); }, {}, { wait }), /boom/);
  assert.equal(n, 1);
  assert.equal(isNetworkAuthError(null), false);
  const login = src('app/login/page.js');
  assert.match(login, /signInWithRetry\(\(c\) => supabase\.auth\.signInWithPassword\(c\)/);
  assert.match(login, /NETWORK_SIGNIN_MSG/);
  assert.doesNotMatch(NETWORK_SIGNIN_MSG, /Failed to fetch/);
});
