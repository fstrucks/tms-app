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
  assert.equal(b.text, 'Layout from Acme Test Logistics, last used Oct 12. 6 fields placed from the saved layout. Review them before filling.');
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

// ===================== Taylor's QA on #68 (2026-10-17): A–D. FAKE broker "Acme Test Logistics" only. =====================
import { detectBrokerName, cleanName } from '../../app/lib/packetBrokerName.js';
import { isCovered, dropCovered, boxOverlap, nameSuggestions, labelKey } from '../../app/lib/packetLayoutApply.js';
import { scoreLayout, headSimilarity, normalizeBrokerName, brokerNamesMatch } from '../../app/lib/packetFingerprint.js';
import { PATCH as PACKET_PATCH, cleanBrokerName } from '../../app/api/packets/[id]/route.js';
import { POST as PROCESS_POST } from '../../app/api/packets/[id]/process/route.js';

const V1_LABELS = ['Carrier name:', 'MC number:', 'DOT number:', 'Contact name:', 'Phone:', 'Email:', 'Truck number:', 'Trailer number:'];
const V2_LABELS = ['Carrier name:', 'Insurance agent:', 'MC number:', 'DOT number:', 'Dispatcher name:', 'Phone:', 'Email:', 'Truck number:', 'Emergency contact:'];
const V1_NAMES = { 'Carrier name:': 'legal_name', 'MC number:': 'mc_number', 'DOT number:': 'dot_number', 'Contact name:': 'contact_name', 'Phone:': 'phone', 'Email:': 'email', 'Truck number:': 'truck_number', 'Trailer number:': 'skip' };
// Mirrors Taylor's FAKE-packet-v1.pdf / FAKE-packet-v2-changed.pdf.
async function acmePdf({ rev = 1, broker = 'Acme Test Logistics', labels = rev === 1 ? V1_LABELS : V2_LABELS } = {}) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([612, 792]);
  p.drawText(`TEST ONLY - FAKE BROKER "${broker}" - NOT A REAL PACKET`, { x: 60, y: 750, size: 10, font: b });
  p.drawText(rev === 1 ? 'Carrier Setup Form' : 'Carrier Setup Form (rev 2)', { x: 60, y: 724, size: 16, font: b });
  p.drawText(rev === 1 ? 'Please complete every blank below and return to the test broker.' : 'Please complete every blank below and return to the test broker.', { x: 60, y: 706, size: 9, font: f });
  const gap = rev === 1 ? 32 : 40;
  labels.forEach((lab, i) => p.drawText(`${lab} ______________________________________`, { x: 60, y: 660 - i * gap, size: 9, font: f }));
  p.drawText('This file contains fake test data only. Do not send to a real broker.', { x: 60, y: rev === 1 ? 90 : 300, size: 8, font: f });
  return Buffer.from(await d.save());
}
const acmeFill = (sb, packetId) => sb.t.packet_fields.filter((r) => r.packet_id === packetId).map((r) => ({ ...r, profile_key: V1_NAMES[r.label] ?? r.profile_key, value_text: null }));
async function acmeLearned({ brokerOnLayout = true } = {}) {
  const sb = memSb({ packets: [pkt(1)], pdfs: { [`${OWNER}/packets/1.pdf`]: await acmePdf() }, profiles: [{ owner_id: OWNER, mc_number: 'MC 111222', legal_name: 'FST Fake Trucking LLC' }] });
  const o = await processPacket({ sb, packetId: pid(1), reader: spyReader() });
  assert.equal(o.fields, V1_LABELS.length);
  const p1 = sb.t.packets[0];
  assert.equal(p1.broker_name, 'Acme Test Logistics'); // B: detected from the PDF text on processing
  const learned = await learnFromFill(sb, { packet: p1, rows: acmeFill(sb, pid(1)), userId: 'u-owner' });
  assert.equal(learned.action, 'create');
  if (!brokerOnLayout) sb.t.packet_layouts[0].broker_name = null; // layouts learned before B have no name
  return sb;
}

test('QA A: changed rev-2 packet from the same fake broker → "looks different" banner, old names offered where labels match', async () => {
  const sb = await acmeLearned();
  const lay = sb.t.packet_layouts[0];
  assert.equal(lay.broker_name, 'Acme Test Logistics');
  await addPacket(sb, 2, await acmePdf({ rev: 2 }));
  const r = spyReader();
  const o = await processPacket({ sb, packetId: pid(2), reader: r });
  assert.equal(o.layout.decision, 'changed'); // before: no match at all (no MC / email on an upload)
  assert.equal(r.calls.length, 1); // fresh detection + naming
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.equal(p2.layout_id, lay.id); assert.equal(p2.layout_applied_at, null); assert.equal(p2.broker_name, 'Acme Test Logistics');
  assert.equal(layoutState(p2, lay), 'changed');
  // GET: banner state + how many fresh fields share a label with last time (Carrier name, MC, DOT, Phone, Email, Truck number).
  const g = await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.equal(g.state, 'changed'); assert.equal(g.matched, 6); assert.equal(g.total, 9); assert.equal(g.names, 5); assert.equal(g.broker_name, 'Acme Test Logistics'); // Truck number already named by its label (r3)
  const b = layoutBanner(g, { canEdit: true });
  assert.equal(b.kind, 'changed'); assert.equal(b.action, 'names'); assert.equal(b.button, 'Use 5 names from last time');
  assert.equal(b.text, 'Acme Test Logistics’s packet looks different from last time, so fields were found fresh. 6 of 9 fields matched last time. 1 already has the same name; 5 can use last time’s name.');
  assert.equal(layoutBanner(g, { canEdit: false }).action, null); // drivers: view-only text
  // POST names: copies them onto the matching fresh fields only.
  const pr = await (await LAYOUT_POST(req('POST', { action: 'names' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('dispatcher') } })).json();
  assert.equal(pr.ok, true); assert.equal(pr.named, 5); assert.equal(pr.matched, 6);
  const by = Object.fromEntries(sb.t.packet_fields.filter((x) => x.packet_id === pid(2)).map((x) => [x.label, x.profile_key]));
  for (const l of ['Carrier name:', 'MC number:', 'DOT number:', 'Phone:', 'Email:', 'Truck number:']) assert.equal(by[l], V1_NAMES[l], l);
  for (const l of ['Insurance agent:', 'Dispatcher name:', 'Emergency contact:']) assert.equal(by[l], null, l); // new labels: still need a name
  const g2 = await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.equal(g2.names, 0); assert.equal(layoutBanner(g2, { canEdit: true }).action, null);
  // Drivers can't copy names.
  const dr = await LAYOUT_POST(req('POST', { action: 'names' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('driver') } });
  assert.equal(dr.status, 403);
});

test('QA A: a layout saved without a broker name still matches the revised form by its header + page structure', async () => {
  const sb = await acmeLearned({ brokerOnLayout: false });
  await addPacket(sb, 2, await acmePdf({ rev: 2 }));
  const o = await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  assert.equal(o.layout.decision, 'changed');
  const g = await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.match(layoutBanner(g, { canEdit: true }).text, /^Acme Test Logistics’s packet looks different/); // packet's Broker field
});

test('QA A: a different broker with the same page structure is NOT flagged as Acme’s changed form; v1 again still auto-applies', async () => {
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmePdf({ rev: 2, broker: 'Zenith Test Freight' }));
  const o = await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  assert.equal(o.layout, undefined);
  assert.equal(sb.t.packets.find((p) => p.id === pid(2)).broker_name, 'Zenith Test Freight');
  await addPacket(sb, 3, await acmePdf());
  const o3 = await processPacket({ sb, packetId: pid(3), reader: spyReader() });
  assert.equal(o3.layout.decision, 'apply'); assert.equal(o3.layout.reason, 'exact'); assert.equal(o3.layout.placed, V1_LABELS.length);
});

test('QA A: scoring — head match + same structure → changed; name conflict or different structure blocks it; head never scores', () => {
  const pg = (head, extra = {}) => ({ w: 612, h: 792, has_text: true, text_hash: extra.th || 'x'.repeat(16), simhash: extra.sh || '0000000000000000', head });
  const H1 = 'a1a1a1a1 b2b2b2b2 c3c3c3c3 d4d4d4d4 e5e5e5e5 f6f6f6f6 07070707 08080808 09090909 10101010';
  const H2 = 'a1a1a1a1 b2b2b2b2 c3c3c3c3 d4d4d4d4 e5e5e5e5 f6f6f6f6 07070707 08080808 09090909 99999999';
  assert.ok(headSimilarity(H1, H2) >= 0.6); assert.equal(headSimilarity(H1, null), null);
  const tpl = { fingerprint: { pages: [pg(H1)] }, layout_key: 'k1', page_count: 1, broker_name: 'Acme Test Logistics' };
  const pkt2 = { fingerprint: { pages: [pg(H2, { th: 'y'.repeat(16), sh: 'ffffffffffffffff' })] }, layout_key: 'k2', page_count: 1 };
  let r = scoreLayout(pkt2, { ...tpl, broker_name: null });
  assert.equal(r.decision, 'changed'); assert.equal(r.reason, 'head_changed'); assert.equal(r.parts.name, 0);
  r = scoreLayout({ ...pkt2, broker_name: 'ACME TEST LOGISTICS, LLC' }, tpl);
  assert.equal(r.decision, 'changed'); assert.equal(r.reason, 'form_changed'); assert.equal(r.nameMatch, true);
  assert.equal(scoreLayout({ ...pkt2, broker_name: 'Zenith Test Freight' }, tpl).decision, 'none');
  assert.equal(scoreLayout({ ...pkt2, fingerprint: { pages: [pg(H2, { th: 'y'.repeat(16), sh: 'ffffffffffffffff' }), pg(H2)] }, page_count: 2 }, { ...tpl, broker_name: null }).decision, 'none');
  assert.equal(normalizeBrokerName('The Acme Test Logistics, Inc.'), 'acme test logistics');
  assert.ok(brokerNamesMatch('Acme Test Logistics LLC', 'acme test logistics')); assert.ok(!brokerNamesMatch('Acme', null));
});

test('QA A: refilling an older packet brings its layout up to date (page heads + broker name) without a new version', async () => {
  const sb = await acmeLearned({ brokerOnLayout: false });
  const lay = sb.t.packet_layouts[0];
  lay.fingerprint = { v: 1, pages: lay.fingerprint.pages.map(({ head, ...p }) => p) }; // learned before v2
  const p1 = sb.t.packets[0];
  const old = { ...p1, fingerprint: { v: 1, pages: p1.fingerprint.pages.map(({ head, ...p }) => p) }, broker_name: null };
  const r = await learnFromFill(sb, { packet: old, rows: acmeFill(sb, pid(1)), userId: 'u-owner', pdfBytes: await acmePdf() });
  assert.equal(r.action, 'touch');
  assert.equal(sb.t.packet_layouts.length, 1);
  assert.ok(lay.fingerprint.pages[0].head); assert.equal(lay.broker_name, 'Acme Test Logistics');
});

test('QA A: nameSuggestions — label match by kind, user rows untouched, ambiguous labels skipped', () => {
  const layout = { fields: [{ kind: 'text', label: 'Phone:', profile_key: 'phone' }, { kind: 'text', label: 'Truck #', profile_key: 'truck_number' },
    { kind: 'text', label: 'Name', profile_key: 'legal_name' }, { kind: 'text', label: 'Name:', profile_key: 'contact_name' }, { kind: 'checkbox', label: 'Email', profile_key: null }] };
  const rows = [{ id: 'a', field_key: 'a', kind: 'text', label: 'PHONE', source: 'model', profile_key: null },
    { id: 'b', field_key: 'b', kind: 'text', label: 'Truck', source: 'local', profile_key: null },
    { id: 'c', field_key: 'c', kind: 'text', label: 'Phone', source: 'user', profile_key: null },
    { id: 'd', field_key: 'd', kind: 'text', label: 'Name', source: 'model', profile_key: null },
    { id: 'e', field_key: 'e', kind: 'checkbox', label: 'Phone', source: 'model', profile_key: null }];
  assert.deepEqual(nameSuggestions(rows, layout).map((x) => [x.id, x.profile_key]), [['a', 'phone'], ['b', 'truck_number']]);
  assert.equal(labelKey(' Carrier name: '), 'carrier name'); assert.equal(labelKey('12:'), null);
});

test('QA B: broker name from the PDF text — quoted, labeled, company line; our own name never used', () => {
  const pg = (lines, h = 2200) => ({ size: [1700, h], words: lines.flatMap((t, i) => t.split(' ').map((w, j) => ({ text: w, top: 100 + i * 60, left: 100 + j * 80 }))) });
  assert.equal(detectBrokerName([pg(['TEST ONLY - FAKE BROKER "Acme Test Logistics" - NOT A REAL PACKET', 'Carrier Setup Form'])]), 'Acme Test Logistics');
  assert.equal(detectBrokerName([pg(['Carrier Setup', 'Broker Name: Zenith Test Freight LLC', 'Carrier name: ________'])]), 'Zenith Test Freight LLC');
  assert.equal(detectBrokerName([pg(['NORTHSTAR FAKE LOGISTICS', 'Carrier onboarding packet'])]), 'Northstar Fake Logistics');
  assert.equal(detectBrokerName([pg(['FST Fake Trucking LLC', 'Carrier onboarding packet'])], { ownNames: ['FST Fake Trucking LLC'] }), null);
  assert.equal(detectBrokerName([pg(['Broker: ____________', 'Carrier name: ______'])]), null); // blank → nothing
  assert.equal(detectBrokerName([pg(['Carrier Setup Form', 'Please complete every blank'])]), null);
  assert.equal(detectBrokerName([]), null);
  assert.equal(cleanName('ACME TEST LOGISTICS (FAKE)'), 'Acme Test Logistics');
});

test('QA B: Broker field — editors save it (trimmed), drivers can’t, empty clears, a new name re-checks layouts', async () => {
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmePdf({ rev: 2, broker: 'Unknown Test Co' }), { broker_name: null });
  const preq = (body) => new Request('http://x/api/packets/x', { method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let rematched = null;
  const deps = (role) => ({ sb, mkUserClient: uc(role), rematch: async (_sb, p) => { rematched = p.broker_name; return null; } });
  let r = await PACKET_PATCH(preq({ broker_name: '  Acme   Test Logistics ' }), { params: { id: pid(2) }, deps: deps('dispatcher') });
  assert.equal(r.status, 200); assert.equal((await r.json()).broker_name, 'Acme Test Logistics');
  assert.equal(sb.t.packets.find((p) => p.id === pid(2)).broker_name, 'Acme Test Logistics'); assert.equal(rematched, 'Acme Test Logistics');
  r = await PACKET_PATCH(preq({ broker_name: 'X' }), { params: { id: pid(2) }, deps: deps('driver') });
  assert.equal(r.status, 403);
  r = await PACKET_PATCH(preq({ broker_name: 'x'.repeat(121) }), { params: { id: pid(2) }, deps: deps('owner') });
  assert.equal(r.status, 400);
  r = await PACKET_PATCH(preq({ broker_name: '' }), { params: { id: pid(2) }, deps: deps('owner') });
  assert.equal((await r.json()).broker_name, null);
  assert.deepEqual(cleanBrokerName(5), { error: 'Broker name must be text.' });
  // The packet page shows the field; the banner prefers the packet's name over the layout's.
  const src = readFileSync('app/packets/PacketMapper.js', 'utf8');
  assert.match(src, /<BrokerField packetId=\{packet\.id\}/); assert.match(src, /method: 'PATCH', body: JSON\.stringify\(\{ broker_name: v \}\)/);
  const b = layoutBanner({ available: true, state: 'applied', broker_name: 'Typed Test Broker', layout: { broker_name: 'Old Name' } }, { canEdit: true, placed: 2 });
  assert.match(b.text, /^Layout from Typed Test Broker\. 2 fields placed/);
  assert.match(layoutBanner({ available: true, state: 'applied', layout: { broker_name: null } }, { placed: 1 }).text, /^Layout from a saved broker/);
});

test('QA B: rematch after the Broker field changes links the layout as a suggestion/changed (never places fields)', async () => {
  const { rematchLayout } = await import('../../app/lib/packetLayouts.js');
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmePdf({ rev: 2, broker: 'Unknown Test Co' }));
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  const p2 = sb.t.packets.find((p) => p.id === pid(2));
  assert.equal(p2.layout_id, null); // different broker header, different name
  const before = sb.t.packet_fields.filter((x) => x.packet_id === pid(2)).length;
  const out = await rematchLayout(sb, { ...p2, broker_name: 'Acme Test Logistics' });
  assert.equal(out.decision, 'changed'); assert.equal(p2.layout_id, sb.t.packet_layouts[0].id); assert.equal(p2.layout_applied_at, null);
  assert.equal(sb.t.packet_fields.filter((x) => x.packet_id === pid(2)).length, before);
});

test('QA C: after "Don’t use this layout", fresh detection never stacks a field on a kept (Left blank) field → can reach Ready', async () => {
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmePdf());
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  // Taylor edited the placed "Trailer number" row (Left blank) → it became a user row, kept across re-runs.
  const tr = sb.t.packet_fields.find((x) => x.packet_id === pid(2) && x.label === 'Trailer number:');
  assert.equal(tr.profile_key, 'skip'); tr.source = 'user';
  const r = await LAYOUT_POST(req('POST', { action: 'dismiss' }), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } });
  assert.equal(r.status, 200);
  const rows = sb.t.packet_fields.filter((x) => x.packet_id === pid(2));
  assert.equal(rows.filter((x) => x.label === 'Trailer number:').length, 1); // before: 2 (kept + fresh)
  assert.equal(rows.length, V1_LABELS.length);
  assert.ok(!rows.some((x) => x !== tr && isCovered(x, [tr])));
  // A forced re-run doesn't bring it back either.
  await processPacket({ sb, packetId: pid(2), force: true, reader: spyReader() });
  assert.equal(sb.t.packet_fields.filter((x) => x.packet_id === pid(2) && x.label === 'Trailer number:').length, 1);
});

test('QA C: overlap check — IoU or mostly-inside counts as covered; other pages / far boxes don’t; render sizes are scaled', () => {
  const kept = [{ page: 1, box: [100, 100, 500, 140], page_w: 1700, page_h: 2200 }];
  assert.ok(boxOverlap([100, 100, 500, 140], [100, 100, 500, 140]).iou === 1);
  assert.equal(isCovered({ page: 1, box: [110, 104, 490, 142] }, kept), true); // same blank, slightly different box
  assert.equal(isCovered({ page: 1, box: [200, 110, 300, 135] }, kept), true); // small box inside the kept one
  assert.equal(isCovered({ page: 1, box: [100, 200, 500, 240] }, kept), false); // next line
  assert.equal(isCovered({ page: 2, box: [100, 100, 500, 140] }, kept), false);
  assert.equal(isCovered({ page: 1, box: [50, 50, 250, 70], page_w: 850, page_h: 1100 }, kept), true); // half-size render
  assert.deepEqual(dropCovered([{ page: 1, box: [100, 100, 500, 140] }, { page: 1, box: [100, 300, 500, 340] }], kept).map((x) => x.box[1]), [300]);
  assert.equal(dropCovered([{ page: 1, box: [1, 1, 2, 2] }], []).length, 1);
});

test('QA D: banner re-read when processing finishes (no reload); upload starts processing server-side; list kicks stuck packets', async () => {
  const m = readFileSync('app/packets/PacketMapper.js', 'utf8');
  assert.match(m, /const layoutKeyDep = `\$\{packet\?\.id\}\|\$\{packet\?\.status\}\|\$\{packet\?\.processed_at/);
  assert.match(m, /\}, \[layoutKeyDep, layoutApi\]\);/);
  const page = readFileSync('app/packets/[id]/page.js', 'utf8');
  assert.match(page, /isProcessing\(d\.packet\?\.status\) && i < PROCESS_POLL_MS\.length/);
  const list = readFileSync('app/packets/page.js', 'utf8');
  assert.match(list, /process\?background=1`, \{ method: 'POST', keepalive: true/);
  assert.match(list, /if \(r\.status !== 'received' \|\| kicked\.current\.has\(r\.id\)\) continue;/);
  // background=1: answers 202 at once and hands the job to waitUntil.
  const jobs = []; let ran = false;
  const sb = memSb({ packets: [pkt(5)] });
  const res = await PROCESS_POST(new Request(`http://x/api/packets/${pid(5)}/process?background=1`, { method: 'POST', headers: { authorization: 'Bearer t' } }),
    { params: { id: pid(5) }, deps: { sb, mkUserClient: uc('driver'), waitUntil: (p) => jobs.push(p), process: async () => { ran = true; return { fields: 0 }; } } });
  assert.equal(res.status, 202); assert.deepEqual(await res.json(), { started: true });
  assert.equal(jobs.length, 1); await jobs[0]; assert.equal(ran, true);
});

// ===================== Taylor's round-2 retest on #68 (2026-10-17). FAKE data only. =====================
import { detectPage, LABEL_REACH_PX } from '../../app/lib/packetDetect.js';
import { GET as FIELDS_GET, pkt as fieldsPacket } from '../../app/api/packets/[id]/fields/route.js';
import { fillReusable, findReusableFill, fillWithRetry, lastFieldChange, RECENT_FILL_MS } from '../../app/lib/packetFillRetry.js';
import { isLayoutPlaced } from '../../app/lib/packetLayoutBanner.js';

// Taylor's rev-2 PDF: labels at the left margin, blanks starting ~2 in. to the right (556 px at 200 dpi).
async function acmeWidePdf({ labels = V2_LABELS } = {}) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([612, 792]);
  p.drawText('TEST ONLY - FAKE BROKER "Acme Test Logistics" - NOT A REAL PACKET', { x: 60, y: 750, size: 10, font: b });
  p.drawText('Carrier Setup Form (rev 2)', { x: 60, y: 724, size: 16, font: b });
  labels.forEach((lab, i) => { p.drawText(lab, { x: 60, y: 660 - i * 40, size: 9, font: f }); p.drawText('_'.repeat(40), { x: 200, y: 660 - i * 40, size: 9, font: f }); });
  return Buffer.from(await d.save());
}

test('QA r2 A root cause: labels more than 300 px left of the blank were cut to "" / "agent:" → no label could match last time', async () => {
  const ex = await extractPdf(await acmeWidePdf());
  const { detectPacket } = await import('../../app/lib/packetDetect.js');
  const labels = detectPacket(ex.pages).map((x) => x.label);
  assert.deepEqual(labels, V2_LABELS); // before the fix: ['', 'agent:', '', '', 'name:', '', '', '', 'contact:']
  // Reach stops at the end of another blank on the same row (two-column forms keep their own labels).
  const words = [{ text: 'Name:', left: 100, top: 190, width: 80, height: 20 }, { text: 'Phone:', left: 900, top: 190, width: 90, height: 20 }];
  const lines = [{ x: 200, y: 210, w: 600, h: 2 }, { x: 1000, y: 210, w: 500, h: 2 }];
  assert.deepEqual(detectPage({ page: 1, size: [1700, 2200], words, lines }).map((x) => x.label), ['Name:', 'Phone:']);
  const far = detectPage({ page: 1, size: [1700, 2200], words: [{ text: 'Far:', left: 100, top: 190, width: 50, height: 20 }], lines: [{ x: 100 + LABEL_REACH_PX + 60, y: 210, w: 400, h: 2 }] });
  assert.equal(far[0].label, ''); // beyond 3.5 in: not a label
});

test('QA r2 A: end to end — v1 learned, wide-gap rev 2 → "changed" + "Use 6 names from last time"; Find fields again recovers an old packet', async () => {
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmeWidePdf());
  const o = await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  assert.equal(o.layout.decision, 'changed');
  const g = await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.equal(g.names, 5); assert.equal(g.matched, 6);
  assert.equal(layoutBanner(g, { canEdit: true }).button, 'Use 5 names from last time');
  // An old packet processed with the short labels (a919090e): its fields had no usable labels → no offer; a forced
  // re-run (the new "Find fields again" button: POST /process?force=1&background=1, editors only) fixes it.
  for (const r of sb.t.packet_fields.filter((x) => x.packet_id === pid(2))) r.label = r.label === 'Insurance agent:' ? 'agent:' : '';
  assert.equal((await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json()).names, 0);
  const jobs = [];
  const pr = (role) => PROCESS_POST(new Request(`http://x/api/packets/${pid(2)}/process?force=1&background=1`, { method: 'POST', headers: { authorization: 'Bearer t' } }),
    { params: { id: pid(2) }, deps: { sb, mkUserClient: uc(role), waitUntil: (p) => jobs.push(p), process: (args) => processPacket({ ...args, reader: spyReader() }) } });
  assert.equal((await pr('driver')).status, 403);
  assert.equal((await pr('dispatcher')).status, 202); await Promise.all(jobs);
  assert.equal((await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json()).matched, 6);
  const m = readFileSync('app/packets/PacketMapper.js', 'utf8');
  assert.match(m, />Find fields again<\/button>/); assert.match(m, /process\?force=1&background=1/);
});

test('QA r2 B root cause: GET /fields dropped broker_name from the packet, so the Broker field always opened empty', async () => {
  const sb = await acmeLearned();
  assert.equal(sb.t.packets[0].broker_name, 'Acme Test Logistics');
  const r = await FIELDS_GET(new Request(`http://x/api/packets/${pid(1)}/fields`, { headers: { authorization: 'Bearer t' } }), { params: { id: pid(1) }, deps: { sb, mkUserClient: uc('owner') } });
  const j = await r.json();
  assert.equal(j.packet.broker_name, 'Acme Test Logistics');
  for (const k of ['processed_at', 'layout_id', 'layout_applied_at', 'layout_dismissed_at']) assert.ok(k in j.packet, k);
  assert.equal(fieldsPacket({ id: 'x' }).broker_name, null); // column absent → null, never undefined
  // Saved names survive a reopen: PATCH writes packets.broker_name, GET /fields returns it.
  const preq = new Request('http://x/api/packets/x', { method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ broker_name: 'Typed Fake Broker' }) });
  await PACKET_PATCH(preq, { params: { id: pid(1) }, deps: { sb, mkUserClient: uc('owner'), rematch: async () => null } });
  const j2 = await (await FIELDS_GET(new Request(`http://x/api/packets/${pid(1)}/fields`, { headers: { authorization: 'Bearer t' } }), { params: { id: pid(1) }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.equal(j2.packet.broker_name, 'Typed Fake Broker');
});

test('QA r2 C: a placed field edited to "Left blank" still counts as placed (banner 8 = summary 8)', async () => {
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmePdf());
  await processPacket({ sb, packetId: pid(2), reader: spyReader() });
  const rows = sb.t.packet_fields.filter((x) => x.packet_id === pid(2));
  rows.find((x) => x.label === 'Trailer number:').source = 'user'; // edit keeps the lay-… key
  assert.equal(placedCount(rows), 8); assert.equal(rows.length, 8);
  assert.match(layoutBanner({ available: true, state: 'applied', layout: { broker_name: 'Acme Test Logistics' } }, { canEdit: true, placed: placedCount(rows) }).text, /8 fields placed/);
  assert.equal(isLayoutPlaced({ source: 'user', field_key: 'u-abc' }), false); // fields the user added aren't "placed"
});

test('QA r2 D: Fill retry — one automatic retry on a dropped connection, reusing a fill that just finished (no double fill)', async () => {
  const now = Date.parse('2026-10-17T19:00:00Z');
  const iso = (dt) => new Date(now + dt).toISOString();
  const rows = [{ updated_at: iso(-60_000) }, { signed_at: iso(-30_000) }];
  assert.equal(lastFieldChange(rows), now - 30_000);
  assert.equal(fillReusable({ filled_path: 'f.pdf', filled_at: iso(-5_000) }, rows, now), true);
  assert.equal(fillReusable({ filled_path: 'f.pdf', filled_at: iso(-40_000) }, rows, now), false); // signed after that fill
  assert.equal(fillReusable({ filled_path: 'f.pdf', filled_at: iso(-RECENT_FILL_MS - 1) }, [], now), false);
  assert.equal(fillReusable({ filled_path: null, filled_at: iso(-1000) }, [], now), false);
  // The first attempt is still running when the retry arrives: the retry waits for it instead of filling again.
  let t = now, reads = 0;
  const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { reads++; return { data: reads >= 3 ? { id: 'p', filled_path: 'f2.pdf', filled_at: new Date(t).toISOString() } : { id: 'p' } }; } }) }) }) };
  const got = await findReusableFill(sb, { id: 'p' }, rows, { now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(got.filled_path, 'f2.pdf');
  t = now; reads = -100; // nothing ever lands → fill normally after the wait
  assert.equal(await findReusableFill(sb, { id: 'p' }, rows, { now: () => t, sleep: async (ms) => { t += ms; } }), null);
  // Client: retries only a network drop (status 0), once, with ?retry=1.
  const seen = [];
  const res = await fillWithRetry(async (retry) => { seen.push(retry); return retry ? { ok: true, url: 'u' } : { error: 'Network problem.', status: 0 }; }, { sleep: async () => {} });
  assert.deepEqual(seen, [false, true]); assert.equal(res.ok, true);
  const seen2 = [];
  await fillWithRetry(async (r) => { seen2.push(r); return { error: 'Sign the signature field first.', status: 409 }; }, { sleep: async () => {} });
  assert.deepEqual(seen2, [false]);
  const both = await fillWithRetry(async () => ({ error: 'x', status: 0 }), { sleep: async () => {} });
  assert.match(both.error, /tap Fill again/);
  const page = readFileSync('app/packets/[id]/page.js', 'utf8');
  assert.match(page, /fillWithRetry\(\(retry\) => api\(`\/api\/packets\/\$\{id\}\/fill\$\{retry \? '\?retry=1' : ''\}`/);
  const route = readFileSync('app/api/packets/[id]/fill/route.js', 'utf8');
  assert.match(route, /searchParams\.get\('retry'\) === '1'/); assert.match(route, /reused: true/);
});

// ===================== Taylor's round-3 retest on #68 (2026-10-17). FAKE data only. =====================
import { canonicalLabel, labelSimilarity, applyLabelRules, ruleKeyFor } from '../../app/lib/packetLabelRules.js';
import { labelMatches } from '../../app/lib/packetLayoutApply.js';
import { buildPacketFields } from '../../app/lib/packetFields.js';
import { byPosition } from '../../app/lib/packetMapperModel.js';
import { resolveFillValues } from '../../app/lib/packetFillValues.js';
import { fillBlockers } from '../../app/lib/packetFillReady.js';

// The prod AI names the fields it understands (company-profile keys) and leaves the rest unnamed.
const aiReader = (map) => ({ enabled: true, nameFields: async (fs) => ({ fields: fs.map((f) => ({ ...f, profile_key: map[f.label] ?? null, confidence: map[f.label] ? 0.95 : 0 })) }) });
const AI = { 'Carrier name:': 'legal_name', 'MC number:': 'mc_number', 'DOT number:': 'dot_number', 'Phone:': 'phone', 'Email:': 'email', 'Owner name:': 'signer_name' };

test('QA r3 A root cause: 6 labels DID match, but the AI had already named 5 the same way, so only 1 name could change', async () => {
  const sb = await acmeLearned();
  await addPacket(sb, 2, await acmeWidePdf());
  await processPacket({ sb, packetId: pid(2), reader: aiReader(AI) });
  const rows = sb.t.packet_fields.filter((x) => x.packet_id === pid(2));
  const lm = labelMatches(rows, sb.t.packet_layouts[0]);
  assert.equal(lm.matched.length, 6); // Carrier name, MC, DOT, Phone, Email, Truck number
  assert.equal(lm.toCopy.length, 0); // AI got 5; Truck number is now named from its label (r3), so nothing left to copy
  // Old behavior for comparison (no label rule): only Truck number differed → "Use 1 name".
  const old = rows.map((r) => (r.label === 'Truck number:' ? { ...r, profile_key: null } : r));
  assert.equal(labelMatches(old, sb.t.packet_layouts[0]).toCopy.length, 1);
  const g = await (await LAYOUT_GET(req('GET'), { params: { id: pid(2) }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.deepEqual([g.matched, g.total, g.names], [6, 9, 0]);
  const b = layoutBanner(g, { canEdit: true });
  assert.equal(b.text, 'Acme Test Logistics’s packet looks different from last time, so fields were found fresh. 6 of 9 fields matched last time. They already have the same names.');
  assert.equal(b.action, null);
});

test('QA r3 A: label normalizing + fuzzy + meaning; ambiguous labels never guessed', () => {
  assert.equal(canonicalLabel('Truck #:'), 'truck'); assert.equal(canonicalLabel('TRUCK NUMBER'), 'truck'); assert.equal(canonicalLabel('Truck No.'), 'truck');
  assert.equal(canonicalLabel('E-mail:'), 'email'); assert.equal(canonicalLabel('Tel.'), 'phone'); assert.equal(canonicalLabel('MC Number:'), 'mc');
  assert.equal(canonicalLabel('Insurance Agents'), 'insurance agent'); assert.equal(canonicalLabel(':'), null);
  assert.ok(labelSimilarity('Carier name', 'Carrier name:') >= 0.6); // typo
  assert.equal(labelSimilarity('Phone', 'Email'), 0);
  const layout = { fields: [
    { kind: 'text', label: 'Carrier name:', profile_key: 'legal_name' }, { kind: 'text', label: 'Contact name:', profile_key: 'contact_name' },
    { kind: 'text', label: 'Truck number:', profile_key: 'truck_number' }, { kind: 'text', label: 'E-mail', profile_key: 'email' },
    { kind: 'text', label: 'Phone #', profile_key: 'phone' }, { kind: 'text', label: 'Phone number', profile_key: 'contact_phone' }] };
  const f = (id, label) => ({ id, field_key: id, kind: 'text', label, source: 'model', profile_key: null });
  const m = labelMatches([f('a', 'CARRIER NAME'), f('b', 'Truck unit #'), f('c', 'Email:'), f('d', 'Name:'), f('e', 'Phone:'), f('g', 'Carier Name')], layout);
  const by = Object.fromEntries(m.matched.map((x) => [x.id, [x.profile_key, x.how]]));
  assert.deepEqual(by.a, ['legal_name', 'label']);
  assert.deepEqual(by.b, ['truck_number', 'label']); // "Truck unit #" and "Truck number:" both normalize to "truck"
  const mm = labelMatches([f('t', 'Tractor #:')], layout).matched;
  assert.deepEqual(mm.map((x) => [x.profile_key, x.how]), [['truck_number', 'meaning']]); // different words, same meaning
  assert.deepEqual(by.c, ['email', 'label']);
  assert.equal(by.d, undefined); // "Name" fits Carrier name and Contact name equally → no guess
  assert.equal(by.e, undefined); // "Phone" was used for two different names last time → ambiguous
  assert.equal(by.g, undefined); // the only Carrier name was already used by a (each old field once)
  assert.equal(ruleKeyFor('Truck unit #:'), 'truck_number'); assert.equal(ruleKeyFor('Trailer unit #:'), 'trailer_number');
});

test('QA r3 A: refilling v1 refreshes the stored labels (new version) when only labels changed', () => {
  const fp = { v: 2, pages: [{ w: 612, h: 792, text_hash: 'a'.repeat(16), simhash: '0'.repeat(16), has_text: true, head: 'x' }] };
  const row = (label, key, y) => ({ page: 1, kind: 'text', label, box: [100, y, 500, y + 30], profile_key: key, page_w: 1700, page_h: 2200 });
  const target = { version: 1, fields: layoutFieldsFromRows([row('name:', 'legal_name', 100), row('', 'phone', 200)], fp) };
  const plan = planLearn({ packet: { fingerprint: fp }, rows: [row('Carrier name:', 'legal_name', 100), row('Phone:', 'phone', 200)], target });
  assert.equal(plan.action, 'version'); assert.equal(plan.version, 2);
  assert.deepEqual(plan.fields.map((x) => x.label), ['Carrier name:', 'Phone:']);
});

test('QA r3 C: banner counts state "N of M" and agree with the field summary', () => {
  const info = { available: true, state: 'applied', layout: { broker_name: 'Acme Test Logistics' } };
  assert.match(layoutBanner(info, { canEdit: true, placed: 8, total: 8 }).text, / 8 fields placed from the saved layout\./);
  assert.match(layoutBanner(info, { canEdit: true, placed: 7, total: 9 }).text, / 7 of 9 fields placed from the saved layout\./);
  const ch = { available: true, state: 'changed', layout: { broker_name: 'Acme Test Logistics' }, matched: 1, names: 1, total: 9 };
  assert.equal(layoutBanner(ch, { canEdit: true }).text, 'Acme Test Logistics’s packet looks different from last time, so fields were found fresh. 1 of 9 fields matched last time. 1 can use last time’s name.');
  assert.equal(layoutBanner({ ...ch, matched: 0, names: 0 }, { canEdit: true }).text, 'Acme Test Logistics’s packet looks different from last time, so fields were found fresh.');
  assert.match(readFileSync('app/packets/PacketMapper.js', 'utf8'), /\{ canEdit, placed: placedCount\(fields\), total: fields\.length \}/);
});

test('QA r3 D: big Download button after filling; unnamed fields are left blank BY DESIGN (never blocked, never drawn)', () => {
  const m = readFileSync('app/packets/PacketMapper.js', 'utf8');
  assert.match(m, /data-testid="download-filled" role="button"/);
  assert.match(m, /filled\?\.url \? 'Fill again' : 'Fill & download PDF'/);
  assert.match(m, /unnamed field\$\{blank === 1 \? ' was' : 's were'\} left blank/);
  // Evidence: fillBlockers (since #62) only blocks on no fields / unsaved / bank confirm / unsigned — never on names.
  const fields = [{ id: 'a', kind: 'text', profile_key: null }, { id: 'b', kind: 'text', profile_key: 'legal_name' }];
  assert.deepEqual(fillBlockers(fields), []);
  // resolveFillValues keeps the unnamed box with no value; packetFill skips empty values (nothing drawn).
  const r = resolveFillValues([{ id: 'a', page: 1, kind: 'text', box: [0, 0, 10, 10], profile_key: null }, { id: 'b', page: 1, kind: 'text', box: [0, 20, 10, 30], profile_key: 'legal_name' }], { legal_name: 'Fake Carrier LLC' }, { decrypt: () => '' });
  assert.equal(r.fields.find((x) => x.id === 'a').value, undefined); assert.equal(r.fields.find((x) => x.id === 'b').value, 'Fake Carrier LLC');
  assert.match(readFileSync('app/lib/packetFill.js', 'utf8'), /f\.value == null \|\| f\.value === ''/);
});

test('QA r3 E: "Owner name" → Owner name (not Signer name); other labels keep the AI’s pick; side list in reading order', async () => {
  const out = applyLabelRules([{ kind: 'text', label: 'Owner name:', profile_key: 'signer_name', confidence: 0.8 }, { kind: 'text', label: 'Authorized signer name:', profile_key: 'signer_name', confidence: 0.9 },
    { kind: 'text', label: 'Contact name:', profile_key: 'legal_name', confidence: 0.5 }, { kind: 'text', label: 'Contact name:', profile_key: null }, { kind: 'checkbox', label: 'Owner name', profile_key: null }]);
  assert.deepEqual(out.map((x) => x.profile_key), ['owner_name', 'signer_name', 'legal_name', 'contact_name', null]);
  // End to end through naming: the AI says signer_name for "Owner name:".
  const d = await PDFDocument.create(); const fnt = await d.embedFont(StandardFonts.Helvetica); const p = d.addPage([612, 792]);
  ['Company legal name:', 'Owner name:', 'Truck unit #:'].forEach((l, i) => { p.drawText(l, { x: 60, y: 700 - i * 30, size: 9, font: fnt }); p.drawText('_'.repeat(40), { x: 200, y: 700 - i * 30, size: 9, font: fnt }); });
  const ex = await extractPdf(Buffer.from(await d.save()));
  const { rows } = await buildPacketFields({ packetId: 'p', ownerId: 'o', pages: ex.pages, reader: aiReader({ 'Company legal name:': 'legal_name', 'Owner name:': 'signer_name' }) });
  assert.deepEqual(rows.map((r) => [r.label, r.profile_key]), [['Company legal name:', 'legal_name'], ['Owner name:', 'owner_name'], ['Truck unit #:', 'truck_number']]);
  const { KEY_LABELS } = await import('../../app/lib/packetMapperModel.js');
  assert.equal(KEY_LABELS.owner_name, 'Owner name');
  // Reading order: page, then top to bottom (same row within 12 px), then left to right.
  const f = (id, page, x, y) => ({ id, page, box: [x, y, x + 50, y + 20] });
  assert.deepEqual(byPosition([f('d', 2, 10, 10), f('c', 1, 10, 300), f('b', 1, 600, 105), f('a', 1, 100, 100)]).map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.match(readFileSync('app/packets/PacketMapper.js', 'utf8'), /const onPage = byPosition\(fields\.filter\(\(f\) => f\.page === page\)\)/);
});

// ===================== URGENT (Oct 17): packet pages stuck on "Couldn't check your sign-in just now" =====================
import { packetAccess, jwtClaims, checkUser } from '../../app/lib/packetServer.js';
const fakeJwt = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-signature`;
const fReq = (token) => new Request(`http://x/api/packets/${pid(1)}/fields`, { headers: { authorization: `Bearer ${token}` } });

test('URGENT: Supabase Auth unavailable → the token is verified by the database instead; fields load (no 503 dead end)', async () => {
  const sb = await acmeLearned();
  const tok = fakeJwt({ sub: 'u-owner', email: 'taylor@example.test', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  let calls = 0;
  const down = (rpc) => () => ({ auth: { getUser: async () => { calls++; return { data: { user: null }, error: { status: 500, message: 'Internal server error' } }; } }, rpc });
  const ok = async () => ({ data: 'owner', error: null });
  const r = await FIELDS_GET(fReq(tok), { params: { id: pid(1) }, deps: { sb, mkUserClient: down(ok), authRetryMs: 0 } });
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.canEdit, true); assert.equal(j.packet.broker_name, 'Acme Test Logistics'); assert.ok(j.fields.length > 0);
  assert.equal(calls, 2); // one quick retry before falling back
  // getUser throwing (network) is handled the same way.
  const thrower = () => ({ auth: { getUser: async () => { throw new Error('fetch failed'); } }, rpc: ok });
  assert.equal((await FIELDS_GET(fReq(tok), { params: { id: pid(1) }, deps: { sb, mkUserClient: thrower, authRetryMs: 0 } })).status, 200);
  // The database rejects a bad/forged token → signed out, never let in.
  const bad = down(async () => ({ data: null, error: { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' } }));
  assert.equal((await FIELDS_GET(fReq(tok), { params: { id: pid(1) }, deps: { sb, mkUserClient: bad, authRetryMs: 0 } })).status, 401);
  // Not a member → 404 as usual; expired → 401 (client refreshes the session and retries).
  assert.equal((await FIELDS_GET(fReq(tok), { params: { id: pid(1) }, deps: { sb, mkUserClient: down(async () => ({ data: null, error: null })), authRetryMs: 0 } })).status, 404);
  const old = fakeJwt({ sub: 'u-owner', role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await FIELDS_GET(fReq(old), { params: { id: pid(1) }, deps: { sb, mkUserClient: down(ok), authRetryMs: 0 } })).status, 401);
  // Database also unreachable → 503 with retry (can't verify either way).
  const both = down(async () => ({ data: null, error: { code: '57014', message: 'timeout' } }));
  const b = await packetAccess(fReq(tok), pid(1), { sb, mkUserClient: both, authRetryMs: 0 });
  assert.equal(b.status, 503); assert.equal(b.retry, true);
  // A real rejection from Auth is still a sign-out; a working Auth is untouched.
  assert.deepEqual(await checkUser({ auth: { getUser: async () => ({ data: { user: null }, error: { status: 403, message: 'invalid JWT: token is expired' } }) } }, tok, { retryMs: 0 }), { rejected: true });
  assert.equal(jwtClaims(tok).sub, 'u-owner'); assert.equal(jwtClaims('garbage'), null);
  // Any unexpected throw in the route → JSON 500 with the plain fields message (not HTML, not a sign-in message).
  const boom = await FIELDS_GET(fReq(tok), { params: { id: pid(1) }, deps: { sb: { from: () => { throw new Error('boom'); } }, mkUserClient: down(ok), authRetryMs: 0 } });
  assert.equal(boom.status, 500); assert.match((await boom.json()).error, /Couldn’t load this packet’s fields/);
});

test('URGENT: the packet page says "Couldn’t load this packet’s fields. Try again." (with a Try again button) for non-sign-in failures', () => {
  const page = readFileSync('app/packets/[id]/page.js', 'utf8');
  assert.match(page, /const FIELDS_LOAD_ERROR = 'Couldn’t load this packet’s fields\. Try again\.';/);
  assert.match(page, /if \(d\.signedOut \|\| d\.status === 401\) return \{ error: d\.error \|\| 'Sign in again\.', signedOut: true \};/);
  assert.equal((page.match(/setSt\(fieldsError\(d\)\)/g) || []).length, 2);
  assert.match(page, /data-testid="fields-retry"/);
});
