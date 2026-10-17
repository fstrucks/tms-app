// Carrier packet G wired in: fingerprint on processing, match + auto-place / suggest, learn on fill, dismiss/apply
// routes, banner, inbound forwarded From:, and the fallback while the migration isn't applied. FAKE data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdf } from '../../app/lib/packetPdfText.js';
import { processPacket } from '../../app/lib/packetProcess.js';
import { fingerprintPacket } from '../../app/lib/packetFingerprint.js';
import { layoutRows, layoutFieldsFromRows, layoutChanged, planLearn, LAYOUT_FIELD_KEYS, packetIdentity } from '../../app/lib/packetLayoutApply.js';
import { learnFromFill, prepareLayout, isLayoutSchemaMissing } from '../../app/lib/packetLayouts.js';
import { layoutBanner, placedCount } from '../../app/lib/packetLayoutBanner.js';
import { GET as LAYOUT_GET, POST as LAYOUT_POST, layoutState } from '../../app/api/packets/[id]/layout/route.js';
import { POST as INBOUND } from '../../app/api/inbound/postmark/route.js';
import { parseInbound, bodyText } from '../../app/lib/postmarkInbound.js';

// ---------- fake broker forms ----------
const WORDS = ('acme test logistics carrier setup agreement the carrier agrees to haul freight tendered by broker under the terms below '
  + 'insurance cargo liability limits auto liability general liability certificate holder must list broker as additional insured '
  + 'payment terms quick pay option factoring company remit to name remit address carrier shall not double broker re broker or co broker '
  + 'tracking updates every four hours via app or phone failure to provide updates may result in fines claims procedure seal numbers').split(' ');
const para = (seed, lines = 14) => Array.from({ length: lines }, (_, l) => Array.from({ length: 11 }, (_, i) => WORDS[(l * 11 + i + seed * 5) % WORDS.length]).join(' '));
const LABELS = ['Legal Name:', 'MC Number:', 'Contact name:', 'Truck number:', 'Trailer number:', 'Phone:'];
async function formPdf({ seed = 0, mc = '765432', title = 'ACME TEST LOGISTICS CARRIER SETUP (FAKE)', date = '10/17/2026', tweakLine = null, labels = LABELS, text = true, pages = 1 } = {}) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < pages; n++) {
    const p = d.addPage([612, 792]);
    if (!text) continue;
    p.drawText(`${title} page ${'abcdefgh'[n]}`, { x: 60, y: 750, size: 13, font: f });
    if (mc) p.drawText(`Broker MC# ${mc}   Date: ${date}`, { x: 60, y: 732, size: 9, font: f });
    para(seed + n * 3).forEach((l, i) => p.drawText(i === tweakLine ? 'this line was changed by the broker last week' : l, { x: 60, y: 712 - i * 12, size: 8, font: f }));
    labels.forEach((lab, i) => p.drawText(`${lab} ____________________________`, { x: 60, y: 520 - i * 26, size: 10, font: f }));
  }
  return Buffer.from(await d.save());
}

// ---------- in-memory supabase (enough of the builder for these code paths) ----------
function memSb({ packets = [], fields = [], layouts = [], profiles = [], pdfs = {}, fail = {}, dropCols = [] } = {}) {
  const t = { packets: packets.map((r) => ({ ...r })), packet_fields: fields.map((r) => ({ ...r })), packet_layouts: layouts.map((r) => ({ ...r })),
    company_profiles: profiles, inbound_emails: [] };
  let seq = 0; const log = [];
  const from = (name) => {
    const st = { name, op: 'select', f: [], payload: null, opts: {} };
    const hit = (r) => st.f.every(([k, a, b]) => (k === 'eq' ? r[a] === b : k === 'in' ? b.includes(r[a]) : true));
    const run = (one) => {
      log.push({ name, op: st.op, f: st.f, payload: st.payload });
      const err = fail[`${name}:${st.op}`] || fail[`${name}:*`];
      if (err) return { data: null, error: err };
      if (st.op === 'update' && name === 'packets' && dropCols.some((c) => c in st.payload)) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${dropCols[0]}' column of 'packets' in the schema cache` } };
      const tbl = (t[name] ||= []);
      let rows;
      if (st.op === 'select') rows = tbl.filter(hit).map((r) => { const c = { ...r }; for (const k of dropCols) delete c[k]; return c; });
      else if (st.op === 'update') { rows = tbl.filter(hit); rows.forEach((r) => Object.assign(r, st.payload)); }
      else if (st.op === 'delete') { rows = tbl.filter(hit); t[name] = tbl.filter((r) => !hit(r)); }
      else {
        rows = [];
        for (const p of [].concat(st.payload)) {
          if (st.op === 'upsert' && st.opts.ignoreDuplicates && tbl.some((r) => r.packet_id === p.packet_id && r.field_key === p.field_key)) continue;
          if (name === 'packet_layouts' && p.status === 'active' && tbl.some((r) => r.owner_id === p.owner_id && r.layout_key === p.layout_key && r.status === 'active')) return { data: null, error: { code: '23505', message: 'duplicate active' } };
          const r = { id: `${name}-${++seq}`, ...p }; tbl.push(r); rows.push(r);
        }
      }
      return { data: one ? rows[0] ?? null : rows, error: null };
    };
    const b = {
      select() { return b; }, eq(k, v) { st.f.push(['eq', k, v]); return b; }, in(k, v) { st.f.push(['in', k, v]); return b; }, or() { return b; }, order() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; },
      upsert(p, o = {}) { st.op = 'upsert'; st.payload = p; st.opts = o; return b; }, delete() { st.op = 'delete'; return b; },
      maybeSingle: async () => run(true), single: async () => run(true), then: (res, rej) => Promise.resolve(run(false)).then(res, rej),
    };
    return b;
  };
  return { t, log, from, rpc: async () => ({ data: null }),
    storage: { from: () => ({ download: async (p) => ({ data: pdfs[p] ? new Blob([pdfs[p]]) : null, error: pdfs[p] ? null : { message: 'nf' } }), upload: async () => ({ error: null }), remove: async () => ({}) }) } };
}
const OWNER = 'owner-1';
const LAYOUT_COLS = { fingerprint: null, broker_mc: null, broker_email: null, layout_id: null, layout_score: null, layout_applied_at: null, layout_dismissed_at: null };
const pid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const pkt = (n, extra = {}) => ({ id: pid(n), owner_id: OWNER, status: 'received', file_path: `${OWNER}/packets/${n}.pdf`, ...LAYOUT_COLS, ...extra });
const spyReader = () => { const calls = []; return { calls, enabled: true, nameFields: async (fs) => { calls.push(fs.map((f) => f.page)); return { fields: fs.map((f) => ({ ...f, profile_key: null, confidence: 0.5 })) }; } }; };
const NAMES = { 'Legal Name:': 'legal_name', 'MC Number:': 'mc_number', 'Contact name:': 'custom:Contact name', 'Truck number:': 'truck_number', 'Trailer number:': 'skip', 'Phone:': 'phone' };
// Editor names the detected fields and types values (values must never reach a layout).
const editorFill = (sb, packetId) => sb.t.packet_fields.filter((r) => r.packet_id === packetId).map((r) => ({ ...r, profile_key: NAMES[r.label] ?? r.profile_key,
  value_text: r.label === 'Phone:' ? '555-0100' : r.label === 'Truck number:' ? 'T-104' : null, value_ciphertext: r.label === 'Legal Name:' ? 'CIPHERTEXT-SECRET' : null,
  value_last4: r.label === 'Legal Name:' ? '9911' : null, signature_path: null, signer_name: 'Pat Fake', confirmed_at: null }));

// Learn a layout from packet 1, then return the sb for more packets.
async function learnedSb({ mc = '765432' } = {}) {
  const pdf1 = await formPdf({ mc });
  const sb = memSb({ packets: [pkt(1)], pdfs: { [`${OWNER}/packets/1.pdf`]: pdf1 }, profiles: [{ owner_id: OWNER, mc_number: 'MC 111222' }] });
  const o = await processPacket({ sb, packetId: pid(1), reader: spyReader() });
  assert.equal(o.fields, LABELS.length); assert.equal(o.layout, undefined);
  const packet = { ...sb.t.packets[0], broker_name: 'Acme Test Logistics' };
  const learned = await learnFromFill(sb, { packet, rows: editorFill(sb, pid(1)), userId: 'u-owner' });
  assert.equal(learned.action, 'create'); assert.equal(learned.version, 1);
  return sb;
}
async function addPacket(sb, n, pdf, extra = {}) { sb.t.packets.push(pkt(n, extra)); const p = `${OWNER}/packets/${n}.pdf`; const dl = sb.storage.from; const map = { [p]: pdf };
  sb.storage = { from: () => ({ ...dl(), download: async (q) => (map[q] ? { data: new Blob([map[q]]), error: null } : dl().download(q)) }) }; }

// ---------- matching on processing ----------
test('exact repeat (same form, new date/load digits): fields auto-placed from the layout, AI naming skipped, packet records it', async () => {
  const sb = await learnedSb();
  const lay = sb.t.packet_layouts[0];
  assert.equal(lay.broker_mc, '765432'); // ours (111222) excluded
  assert.equal(lay.broker_name, 'Acme Test Logistics');
  await addPacket(sb, 2, await formPdf({ date: '11/02/2026' }));
  const reader = spyReader();
  const o = await processPacket({ sb, packetId: pid(2), reader });
  assert.equal(o.layout.decision, 'apply'); assert.equal(o.layout.reason, 'exact'); assert.ok(o.layout.score >= 70);
  assert.equal(o.layout.placed, LABELS.length);
  assert.deepEqual(reader.calls, []); // matched page: no detection → no OpenAI naming
  const rows = sb.t.packet_fields.filter((r) => r.packet_id === pid(2));
  assert.ok(rows.every((r) => r.source === 'layout' && r.confidence === 1));
  assert.deepEqual(rows.map((r) => r.profile_key).sort(), Object.values(NAMES).sort()); // custom: and skip kept
  assert.ok(rows.every((r) => r.value_text === undefined && r.value_ciphertext === undefined && r.signature_path === undefined));
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.equal(p2.layout_id, lay.id); assert.ok(p2.layout_applied_at); assert.ok(p2.layout_score >= 70);
  assert.equal(p2.broker_mc, '765432'); assert.equal(p2.fingerprint.pages.length, 1); assert.equal(p2.status, 'review'); assert.equal(p2.manual_reason, null);
  assert.equal(sb.t.packet_layouts[0].use_count, 1);
  assert.equal(layoutState(p2, lay), 'applied');
});

test('fuzzy: broker tweaked a line, same MC → applied (mc_fuzzy); same tweak with no MC → suggest only, detection runs', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf({ tweakLine: 3 }));
  const o = await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  assert.equal(o.layout.decision, 'apply'); assert.equal(o.layout.reason, 'mc_fuzzy');
  assert.equal(o.layout.placed, LABELS.length);
  // Without the MC line the text differs more, and there's no identity: never auto-applied.
  const sb2 = await learnedSb();
  await addPacket(sb2, 3, await formPdf({ tweakLine: 3, mc: null }));
  const r = spyReader();
  const o2 = await processPacket({ sb: sb2, packetId: pid(3), reader: r });
  assert.equal(o2.layout.decision, 'suggest'); assert.equal(o2.layout.reason, 'fuzzy_only');
  assert.equal(r.calls.length, 1); // normal detection + naming
  const p3 = sb2.t.packets.find((p) => p.id === pid(3));
  assert.equal(p3.layout_applied_at, null);
  assert.ok(sb2.t.packet_fields.filter((x) => x.packet_id === pid(3)).every((x) => x.source !== 'layout'));
});

test('MC conflict: identical form text but a different broker MC → never auto-applied (suggest at most)', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf({ mc: '998877' }));
  const o = await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  assert.equal(o.layout.decision, 'suggest'); assert.equal(o.layout.reason, 'mc_conflict');
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.equal(p2.layout_id, sb.t.packet_layouts[0].id); assert.equal(p2.layout_applied_at, null);
  assert.ok(sb.t.packet_fields.filter((x) => x.packet_id === pid(2)).every((x) => x.source === 'model'));
  assert.equal(layoutState(p2, sb.t.packet_layouts[0]), 'suggested');
});

test('changed form: same broker MC, completely different text → fresh detection and a "looks different" banner', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf({ seed: 9, title: 'NEW ONBOARDING PACKET FOR CARRIERS (FAKE)', labels: ['Company:', 'Dispatcher:', 'Email:'] }));
  const r = spyReader();
  const o = await processPacket({ sb, packetId: pid(2), reader: r });
  assert.equal(o.layout.decision, 'changed');
  assert.equal(r.calls.length, 1);
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.equal(layoutState(p2, sb.t.packet_layouts[0]), 'changed');
  assert.match(layoutBanner({ available: true, state: 'changed', layout: { broker_name: 'Acme Test Logistics' } }).text, /looks different from last time, so fields were found fresh/);
});

test('scanned packets: fingerprint stored, never auto-applied, never learned', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf({ text: false }));
  const o = await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  assert.equal(o.manual, 'no_text_layer'); assert.notEqual(o.layout?.decision, 'apply');
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.equal(p2.fingerprint.pages[0].has_text, false); assert.equal(p2.layout_applied_at, null);
  assert.deepEqual(planLearn({ packet: p2, rows: [{ page: 1, kind: 'text', box: [1, 1, 50, 20], profile_key: 'phone' }] }), { action: 'skip', reason: 'scanned' });
});

test('multi-page: matched pages get layout fields, an extra page goes through detection + naming only for itself', async () => {
  const pdf1 = await formPdf({ pages: 2 });
  const sb = memSb({ packets: [pkt(1)], pdfs: { [`${OWNER}/packets/1.pdf`]: pdf1 } });
  await processPacket({ sb, packetId: pid(1), reader: spyReader() });
  await learnFromFill(sb, { packet: sb.t.packets[0], rows: editorFill(sb, pid(1)) });
  // Same 2 pages + an unrelated 3rd page (e.g. a W-9).
  const d = await PDFDocument.load(await formPdf({ pages: 2 })); const extra = await PDFDocument.load(await formPdf({ seed: 20, title: 'REQUEST FOR TAXPAYER FORM (FAKE)', labels: ['Name:'] }));
  const [pg] = await d.copyPages(extra, [0]); d.addPage(pg);
  await addPacket(sb, 2, Buffer.from(await d.save()));
  const r = spyReader();
  const o = await processPacket({ sb, packetId: pid(2), reader: r });
  assert.equal(o.layout.decision, 'apply');
  assert.deepEqual(r.calls, [[3]]); // only page 3 sent for naming
  const rows = sb.t.packet_fields.filter((x) => x.packet_id === pid(2));
  assert.ok(rows.filter((x) => x.page <= 2).every((x) => x.source === 'layout'));
  assert.ok(rows.filter((x) => x.page === 3).every((x) => x.source === 'model'));
});

// ---------- learning + versioning ----------
test('learn: no values, ciphertext, last4, signatures or signer names are ever stored; only whitelisted keys', async () => {
  const sb = await learnedSb();
  const lay = sb.t.packet_layouts[0];
  const json = JSON.stringify(lay);
  for (const bad of ['555-0100', 'T-104', 'CIPHERTEXT-SECRET', '9911', 'Pat Fake', 'value_', 'signature_path', 'signer_name', 'confirmed']) assert.ok(!json.includes(bad), bad);
  assert.ok(lay.fields.every((f) => Object.keys(f).every((k) => LAYOUT_FIELD_KEYS.includes(k))));
  assert.ok(lay.fields.some((f) => f.profile_key === 'custom:Contact name'));
  assert.ok(lay.fields.some((f) => f.profile_key === 'skip'));
  // Bank / EIN / signature rows: position + name only.
  const rows = [
    { page: 1, kind: 'text', box: [10, 10, 200, 40], profile_key: 'bank_routing', value_ciphertext: 'ENC-ROUTING', value_last4: '0015', confirmed_at: 'x' },
    { page: 1, kind: 'text', box: [10, 50, 200, 80], profile_key: 'ein', value_ciphertext: 'ENC-EIN', value_last4: '6789' },
    { page: 1, kind: 'signature', box: [10, 90, 300, 140], profile_key: 'signature', signature_path: 'owner/sig/abc.png', signer_name: 'Pat Fake', signed_at: 'now' },
    { page: 1, kind: 'text', box: [10, 150, 200, 180], profile_key: 'hack', value_text: 'x' },
  ];
  const f = layoutFieldsFromRows(rows);
  const s = JSON.stringify(f);
  for (const bad of ['ENC-', '0015', '6789', 'abc.png', 'Pat Fake', 'hack']) assert.ok(!s.includes(bad), bad);
  assert.deepEqual(f.map((x) => x.profile_key), ['bank_routing', 'ein', 'signature', null]);
  // Applied back: bank numbers must be confirmed again on every packet.
  const fp = { v: 1, pages: [{ w: 612, h: 792, text_hash: 'a', simhash: '0000000000000000', has_text: true }] };
  const { rows: out } = layoutRows({ layout: { fingerprint: fp, fields: f }, packetFingerprint: fp, packetId: 'p', ownerId: 'o' });
  assert.equal(out.find((x) => x.profile_key === 'bank_routing').needs_confirm, true);
  assert.ok(out.every((x) => !('value_text' in x) && !('value_ciphertext' in x)));
});

test('learn: unchanged → touch only; box moved >4 px or a name changed → version 2 supersedes 1; ≤4 px is not a change', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf());
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  const p2 = () => sb.t.packets.find((p) => p.id === pid(2));
  const rows = () => sb.t.packet_fields.filter((r) => r.packet_id === pid(2));
  assert.equal((await learnFromFill(sb, { packet: p2(), rows: rows() })).action, 'touch');
  const nudged = rows().map((r, i) => (i === 0 ? { ...r, box: r.box.map((v) => v + 3) } : r));
  assert.equal((await learnFromFill(sb, { packet: p2(), rows: nudged })).action, 'touch');
  const moved = rows().map((r, i) => (i === 0 ? { ...r, box: [r.box[0] + 30, r.box[1], r.box[2] + 30, r.box[3]] } : r));
  const v = await learnFromFill(sb, { packet: p2(), rows: moved });
  assert.equal(v.action, 'version'); assert.equal(v.version, 2);
  assert.deepEqual(sb.t.packet_layouts.map((l) => [l.version, l.status]), [[1, 'superseded'], [2, 'active']]);
  assert.equal(sb.t.packet_layouts[1].broker_name, 'Acme Test Logistics');
  assert.equal(layoutChanged([{ page: 1, kind: 'text', label: 'a', box: [0, 0, 10, 10], profile_key: 'phone' }], [{ page: 1, kind: 'text', label: 'a', box: [0, 0, 10, 10], profile_key: 'email' }]), true);
});

test('learn: a fuzzy-applied packet (broker changed the form) starts its own layout group; the old one stays active', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf({ tweakLine: 3 }));
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  const r = await learnFromFill(sb, { packet: p2, rows: sb.t.packet_fields.filter((x) => x.packet_id === pid(2)) });
  assert.equal(r.action, 'create');
  assert.equal(sb.t.packet_layouts.filter((l) => l.status === 'active').length, 2);
  assert.equal(sb.t.packet_layouts[1].broker_name, 'Acme Test Logistics');
});

// ---------- routes: roles, dismiss, apply ----------
const req = (method, body) => new Request(`http://x/api/packets/x/layout`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) }, rpc: async () => ({ data: role }) });

test('roles: members (incl. drivers) read the banner state; only owner/dispatcher/management dismiss or apply; others 404', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf());
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  for (const role of ['owner', 'dispatcher', 'management', 'driver']) {
    const g = await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc(role) } });
    assert.equal(g.status, 200); const j = await g.json();
    assert.equal(j.state, 'applied'); assert.equal(j.layout.broker_name, 'Acme Test Logistics'); assert.equal(j.canEdit, role !== 'driver');
    assert.equal(j.layout.fields, undefined); // positions stay server-side
  }
  const d = await LAYOUT_POST(req('POST', { action: 'dismiss' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('driver') } });
  assert.equal(d.status, 403);
  const n = await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc(null) } });
  assert.equal(n.status, 404);
  const bad = await LAYOUT_POST(req('POST', { action: 'nope' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } });
  assert.equal(bad.status, 400);
});

test('dismiss: layout fields removed (user edits kept), layout_dismissed_at set, detection re-runs and does not re-apply', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf());
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  sb.t.packet_fields.push({ id: 'user-1', packet_id: pid(2), owner_id: OWNER, field_key: 'u-1', page: 1, kind: 'text', box: [1, 1, 50, 20], profile_key: 'email', source: 'user' });
  const r = await LAYOUT_POST(req('POST', { action: 'dismiss' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('dispatcher') } });
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.state, 'dismissed'); assert.equal(j.redetected, true);
  const rows = sb.t.packet_fields.filter((x) => x.packet_id === pid(2));
  assert.ok(rows.some((x) => x.id === 'user-1'));
  assert.ok(rows.every((x) => x.source !== 'layout'));
  assert.ok(rows.some((x) => x.source === 'local' || x.source === 'model')); // fresh detection (no AI key in tests → local)
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.ok(p2.layout_dismissed_at); assert.equal(p2.layout_applied_at, null);
  assert.ok(j.fields.some((f) => f.id === 'user-1'));
  // A later forced re-run still respects the dismissal.
  await processPacket({ sb, packetId: pid(2), force: true, reader: spyReader() });
  assert.ok(sb.t.packet_fields.filter((x) => x.packet_id === pid(2)).every((x) => x.source !== 'layout'));
  assert.equal(layoutBanner({ available: true, state: 'dismissed', layout: {} }), null);
});

test('apply a suggested layout: places rows on matched pages, replaces machine rows there, records applied', async () => {
  const sb = await learnedSb();
  await addPacket(sb, 2, await formPdf({ mc: '998877' })); // MC conflict → suggest
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  const r = await LAYOUT_POST(req('POST', { action: 'apply' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('management') } });
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.state, 'applied'); assert.equal(j.placed, LABELS.length);
  const rows = sb.t.packet_fields.filter((x) => x.packet_id === pid(2));
  assert.ok(rows.every((x) => x.source === 'layout'));
  assert.ok(sb.t.packets.find((p) => p.id === pid(2)).layout_applied_at);
  assert.equal(placedCount(j.fields), LABELS.length);
});

// ---------- migration not applied yet ----------
test('missing table/columns: processing falls back to normal detection, routes never 500, fill learning skips', async () => {
  const pdf = await formPdf();
  const missingTable = { code: '42P01', message: 'relation "public.packet_layouts" does not exist' };
  // (a) columns + table missing (packets row has no layout keys)
  const plain = { id: pid(1), owner_id: OWNER, status: 'received', file_path: `${OWNER}/packets/1.pdf` };
  const sb = memSb({ packets: [plain], pdfs: { [plain.file_path]: pdf }, fail: { 'packet_layouts:*': missingTable } });
  const o = await processPacket({ sb, packetId: pid(1), reader: spyReader() });
  assert.equal(o.fields, LABELS.length); assert.equal(o.layout, undefined); assert.equal(sb.t.packets[0].status, 'review');
  assert.ok(!('fingerprint' in sb.t.packets[0]));
  const g = await LAYOUT_GET(req('GET'), { params: { id: pid(1) }, deps: { sb, mkUserClient: uc('owner') } });
  assert.equal(g.status, 200); assert.equal((await g.json()).available, false);
  const p = await LAYOUT_POST(req('POST', { action: 'dismiss' }), { params: { id: pid(1) }, deps: { sb, mkUserClient: uc('owner') } });
  assert.equal(p.status, 503); assert.equal((await p.json()).setupNeeded, true);
  assert.deepEqual(await learnFromFill(sb, { packet: sb.t.packets[0], rows: [] }), { action: 'skip', reason: 'migration_missing' });
  // (b) columns present but the table is missing
  const sb2 = memSb({ packets: [pkt(1)], pdfs: { [`${OWNER}/packets/1.pdf`]: pdf }, fail: { 'packet_layouts:*': missingTable } });
  const o2 = await processPacket({ sb: sb2, packetId: pid(1), reader: spyReader() });
  assert.equal(o2.fields, LABELS.length); assert.equal(sb2.t.packets[0].status, 'review');
  assert.equal((await learnFromFill(sb2, { packet: sb2.t.packets[0], rows: editorFill(sb2, pid(1)) })).reason, 'migration_missing');
  const g2 = await LAYOUT_GET(req('GET'), { params: { id: pid(1) }, deps: { sb: sb2, mkUserClient: uc('driver') } });
  assert.equal(g2.status, 200);
  // (c) packet_fields.source check not widened yet: placing fails → every page detected normally
  const sb3 = await learnedSb();
  await addPacket(sb3, 2, await formPdf());
  const realFrom = sb3.from;
  sb3.from = (name) => { const b = realFrom(name); if (name !== 'packet_fields') return b; const up = b.upsert; b.upsert = (rows, o) => ([].concat(rows).some((r) => r.source === 'layout') ? { then: (res) => res({ error: { code: '23514', message: 'new row violates check constraint "packet_fields_source_check"' } }) } : up(rows, o)); return b; };
  const r3 = spyReader();
  const o3 = await processPacket({ sb: sb3, packetId: pid(2), reader: r3 });
  assert.equal(o3.layout.decision, 'apply_failed'); assert.equal(o3.fields, LABELS.length); assert.equal(r3.calls.length, 1);
  assert.equal(sb3.t.packets.find((x) => x.id === pid(2)).layout_applied_at, null);
  assert.equal(isLayoutSchemaMissing({ code: 'PGRST205', message: "Could not find the table 'public.packet_layouts' in the schema cache" }), true);
  assert.equal(isLayoutSchemaMissing({ code: '23505', message: 'dup' }), false);
});

// ---------- inbound: forwarded From ----------
const basic = 'Basic ' + Buffer.from('u:p').toString('base64');
test('inbound: the forwarded broker From: is saved as broker_email (not our forwarder); body never stored', async () => {
  process.env.POSTMARK_INBOUND_USER = 'u'; process.env.POSTMARK_INBOUND_PASSWORD = 'p';
  const pdf = await formPdf();
  const body = 'FYI see packet\n\n---------- Forwarded message ---------\nFrom: Jo Fake <onboarding@mail.acme-test-logistics.com>\nDate: Fri, Oct 16, 2026\nSubject: Carrier packet\nTo: <marc@fstrucks.com>\n';
  const payload = { FromFull: { Email: 'marc@fstrucks.com' }, MessageID: 'm1', Subject: 'Fwd: Carrier packet', TextBody: body, Headers: [],
    Attachments: [{ Name: 'packet.pdf', ContentType: 'application/pdf', Content: pdf.toString('base64') }] };
  const sb = memSb(); sb.rpc = async () => ({ data: OWNER });
  const waits = [];
  const r = await INBOUND(new Request('http://x', { method: 'POST', headers: { authorization: basic }, body: JSON.stringify(payload) }), { deps: { supabase: sb, waitUntil: (p) => waits.push(p), process: async () => ({}) } });
  assert.equal(r.status, 200);
  assert.equal(sb.t.packets[0].broker_email, 'onboarding@mail.acme-test-logistics.com');
  assert.equal(packetIdentity(sb.t.packets[0]).broker_domain, 'acme-test-logistics.com');
  assert.ok(!JSON.stringify(sb.t.inbound_emails).includes('Forwarded message'));
  // Before the migration, the extra column is rejected → the packet is still created.
  const sb2 = memSb({ dropCols: ['broker_email'] }); sb2.rpc = async () => ({ data: OWNER });
  const r2 = await INBOUND(new Request('http://x', { method: 'POST', headers: { authorization: basic }, body: JSON.stringify({ ...payload, MessageID: 'm2' }) }), { deps: { supabase: sb2, waitUntil: () => {}, process: async () => ({}) } });
  assert.equal(r2.status, 200); assert.equal((await r2.json()).packets, 1);
  assert.equal(sb2.t.packets.length, 1);
  assert.equal(parseInbound({ ...payload, TextBody: undefined, HtmlBody: '<p>From: a@b-test.com</p><p>Sent: today</p>' }).textBody.includes('From: a@b-test.com'), true);
  assert.equal(bodyText({}), '');
});

// ---------- banner ----------
test('banner (PacketMapper only): applied with "Don’t use this layout", suggestion with "Use layout", drivers view-only', () => {
  const info = { available: true, state: 'applied', layout: { broker_name: 'Acme Test Logistics', last_used_at: '2026-10-12T18:00:00Z' } };
  const b = layoutBanner(info, { canEdit: true, placed: 6, tz: 'America/Los_Angeles' });
  assert.equal(b.text, 'Layout from Acme Test Logistics, last used Oct 12. 6 fields placed. Review them before filling.');
  assert.equal(b.button, 'Don’t use this layout'); assert.equal(b.action, 'dismiss');
  assert.equal(layoutBanner(info, { canEdit: false, placed: 1 }).button, null);
  const s = layoutBanner({ ...info, state: 'suggested' }, { canEdit: true, tz: 'America/Los_Angeles' });
  assert.match(s.text, /^This looks like Acme Test Logistics’s packet \(last used Oct 12\)\. Use the saved layout\?$/); assert.equal(s.button, 'Use layout');
  assert.equal(layoutBanner({ ...info, state: 'suggested' }, { canEdit: false }).action, null);
  assert.equal(layoutBanner({ available: false }), null);
  assert.equal(layoutBanner({ ...info, layout: { broker_name: null } }, { canEdit: true, placed: 0 }).text.startsWith('Layout from a saved broker.'), true);
  const m = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
  assert.match(m, /data-testid="layout-banner"/);
  assert.match(m, /\/api\/packets\/\$\{packet\.id\}\/layout/);
  assert.match(m, /Save or discard your changes first/);
  // Client bundle must not pull in node:crypto via the fingerprint library.
  assert.doesNotMatch(readFileSync(new URL('../../app/lib/packetLayoutBanner.js', import.meta.url), 'utf8'), /packetFingerprint|node:/);
});

test('scope: PacketSendBroker.js and the #66 COI files are untouched by this branch', () => {
  let diff = '';
  try { diff = execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8' }) + execSync('git diff --name-only', { encoding: 'utf8' }); } catch { return; } // no git (CI tarball): skip
  for (const f of ['app/packets/PacketSendBroker.js', 'app/packets/PacketCoiRequest.js', 'app/lib/coiRequest.js', 'app/lib/coiTemplate.js', 'app/lib/coiGaps.js']) assert.ok(!diff.includes(f), f);
});
