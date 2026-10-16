import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { dragBox, isTap } from '../../app/lib/packetDrag.js';
import { parseSignature, signaturePath, filledPath, formatPacketDate } from '../../app/lib/packetSign.js';
import { resolveFillValues } from '../../app/lib/packetFillValues.js';
import { fillPacket } from '../../app/lib/packetFill.js';
import { signTarget } from '../../app/lib/packetSignFlow.js';
import { encryptField, decryptField } from '../../app/lib/packetCrypto.js';
import { buildSignaturePayload } from '../../app/lib/signature.js';
import { POST as SIGN } from '../../app/api/packets/[id]/sign/route.js';
import { POST as FILL } from '../../app/api/packets/[id]/fill/route.js';

// ---- tiny valid 2x1 RGBA PNG (fake signature)
function crc(buf) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }
function png() { const h = Buffer.alloc(13); h.writeUInt32BE(2, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 6; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.from([0, 17, 24, 39, 255, 17, 24, 39, 255]))), chunk('IEND', Buffer.alloc(0))]); }
const PNG = png(); const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const KEY = Buffer.alloc(32, 9);
const PID = '00000000-0000-4000-8000-0000000000e5';

test('drag: move clamps to the page, resize keeps a minimum size, small moves are taps', () => {
  assert.deepEqual(dragBox([100, 100, 300, 140], 'move', 50, -20, 1700, 2200), [150, 80, 350, 120]);
  assert.deepEqual(dragBox([100, 100, 300, 140], 'move', 5000, 5000, 1700, 2200), [1500, 2160, 1700, 2200]);
  assert.deepEqual(dragBox([100, 100, 300, 140], 'move', -500, -500, 1700, 2200), [0, 0, 200, 40]);
  assert.deepEqual(dragBox([100, 100, 300, 140], 'resize', 60, 20, 1700, 2200), [100, 100, 360, 160]);
  assert.deepEqual(dragBox([100, 100, 300, 140], 'resize', -900, -900, 1700, 2200), [100, 100, 124, 116]);
  assert.deepEqual(dragBox([100, 100, 300, 140], 'resize', 9000, 9000, 1700, 2200), [100, 100, 1700, 2200]);
  assert.equal(isTap(2, 3), true); assert.equal(isTap(10, 0), false);
});

test('parseSignature: pad contract → PNG bytes; rejects non-PNG, empty name; clamps bad times', () => {
  const now = Date.parse('2026-10-15T20:00:00Z');
  const ok = parseSignature({ dataUrl: DATA_URL, signerName: '  Test  Signer (FAKE) ', signedAt: '2026-10-15T19:59:00Z', method: 'draw' }, { now });
  assert.ok(ok.png.equals(PNG)); assert.equal(ok.signerName, 'Test Signer (FAKE)'); assert.equal(ok.signedAt, '2026-10-15T19:59:00.000Z'); assert.equal(ok.method, 'draw');
  assert.equal(parseSignature({ dataUrl: DATA_URL, signerName: 'X', signedAt: '1999-01-01', method: 'type' }, { now }).signedAt, new Date(now).toISOString());
  assert.match(parseSignature({ dataUrl: 'data:image/jpeg;base64,AAAA', signerName: 'X' }).error, /PNG/);
  assert.match(parseSignature({ dataUrl: `data:image/png;base64,${Buffer.from('not a png at all!!').toString('base64')}`, signerName: 'X' }).error, /PNG/);
  assert.match(parseSignature({ dataUrl: DATA_URL, signerName: '  ' }).error, /name/);
  assert.equal(signaturePath('own', 'pk', 'f1', 5), 'own/packets/signatures/pk/f1-5.png');
  assert.equal(filledPath('own', 'pk', 5), 'own/packets/filled/pk-5.pdf');
  assert.equal(formatPacketDate('2026-10-16T03:00:00Z'), '10/15/2026'); // LA time
});

test('signTarget: signature → itself; date → first unsigned signature; other → normal edit', () => {
  const fs = [{ id: 's1', kind: 'signature', signed: true }, { id: 's2', kind: 'text', profile_key: 'signature' }, { id: 'd', kind: 'date' }, { id: 't', kind: 'text' }];
  assert.deepEqual(signTarget(fs, fs[0]), { id: 's1' });
  assert.deepEqual(signTarget(fs, fs[2]), { id: 's2' });
  assert.equal(signTarget(fs, fs[3]), null);
  assert.match(signTarget([{ id: 'd', kind: 'date' }], { id: 'd', kind: 'date' }).error, /Signature field/);
  assert.match(signTarget([], { id: 'tmp-1', kind: 'signature' }).error, /Save/);
});

test('resolveFillValues: field value, then profile, decrypts bank/EIN server-side, dates from signing', () => {
  const dec = (c) => decryptField(c, KEY);
  const rows = [
    { id: 'a', page: 1, kind: 'text', box: [1, 1, 9, 9], profile_key: 'legal_name' },
    { id: 'b', page: 1, kind: 'text', box: [1, 1, 9, 9], profile_key: 'ein' },
    { id: 'c', page: 1, kind: 'text', box: [1, 1, 9, 9], profile_key: 'bank_routing', value_ciphertext: encryptField('011000015', KEY), needs_confirm: true, confirmed_at: 'x' },
    { id: 'd', page: 1, kind: 'date', box: [1, 1, 9, 9], profile_key: 'date' },
    { id: 'e', page: 1, kind: 'signature', box: [1, 1, 9, 9], profile_key: 'signature', signature_path: 'p.png', signed_at: '2026-10-15T18:00:00Z' },
    { id: 'f', page: 1, kind: 'text', box: [1, 1, 9, 9], profile_key: 'mc_number', value_text: 'MC-000000' },
  ];
  const profile = { legal_name: 'Test Trucking Co (FAKE)', mc_number: 'MC-999', ein_ciphertext: encryptField('000000000', KEY) };
  const { fields, missing } = resolveFillValues(rows, profile, { decrypt: dec, images: { 'p.png': PNG } });
  const v = Object.fromEntries(fields.map((f) => [f.id, f.value]));
  assert.equal(v.a, 'Test Trucking Co (FAKE)'); assert.equal(v.b, '00-0000000'); assert.equal(v.c, '011000015');
  assert.equal(v.d, '10/15/2026'); assert.equal(v.f, 'MC-000000'); assert.ok(fields.find((f) => f.id === 'e').image); assert.equal(missing.length, 0);
  assert.equal(resolveFillValues([{ ...rows[4], signature_path: null }], null, { decrypt: dec }).missing.length, 1);
});

test('fillPacket draws the signature PNG inside its box', async () => {
  const d = await PDFDocument.create(); d.addPage([612, 792]); const pdf = await d.save();
  const out = await fillPacket(pdf, [{ id: 's', page: 1, kind: 'signature', box: [200, 1400, 800, 1500], image: PNG }, { id: 't', page: 1, kind: 'text', box: [200, 200, 800, 240], value: 'FAKE' }]);
  assert.equal(out.drawn, 2);
  assert.match(Buffer.from(out.bytes).toString('latin1'), /\/Subtype \/Image/);
});

// ---- fake supabase with storage for the sign/fill routes
function fakeSb({ packet, fields, profile = null, files = {} }) {
  const tbl = { packets: [packet], packet_fields: fields, company_profiles: profile ? [profile] : [] };
  const store = { ...files }, uploads = [];
  const from = (name) => {
    const st = { op: 'select', f: [], payload: null };
    const run = () => {
      const rows = tbl[name].filter((r) => st.f.every(([k, v]) => r[k] === v));
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: null, error: null }; }
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, order() { return b; }, update(p) { st.op = 'update'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve(run()).then(res, rej) };
    return b;
  };
  const storage = { from: () => ({
    upload: async (p, bytes) => { uploads.push(p); store[p] = Buffer.from(bytes); return { error: null }; },
    download: async (p) => (store[p] ? { data: new Blob([store[p]]), error: null } : { data: null, error: { message: 'Object not found' } }),
    remove: async (ps) => { ps.forEach((p) => delete store[p]); return {}; },
    createSignedUrl: async (p, s, o) => ({ data: { signedUrl: `https://x/${p}?download=${o?.download}` } }),
  }) };
  return { from, storage, store, uploads, tbl };
}
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async () => ({ data: role }) });
const req = (path, body) => new Request(`http://x/api/packets/${PID}/${path}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const pkt = () => ({ id: PID, owner_id: 'owner1', status: 'review', file_path: 'owner1/packets/1-test.pdf', original_filename: 'Test Broker Packet (FAKE).pdf' });
const rowsFor = () => [
  { id: 'sig', packet_id: PID, page: 1, kind: 'signature', box: [200, 1400, 800, 1500], profile_key: 'signature' },
  { id: 'dt', packet_id: PID, page: 1, kind: 'date', box: [900, 1400, 1200, 1440], profile_key: 'date' },
  { id: 'nm', packet_id: PID, page: 1, kind: 'text', box: [200, 200, 800, 240], profile_key: 'legal_name' },
  { id: 'ac', packet_id: PID, page: 1, kind: 'text', box: [200, 300, 800, 340], profile_key: 'bank_account', needs_confirm: true, confirmed_at: null, value_ciphertext: encryptField('000123456789', KEY) },
];

test('sign route: editors sign into the OWNER folder, dates auto-fill; drivers 403; bad PNG 422', async () => {
  const sb = fakeSb({ packet: pkt(), fields: rowsFor() });
  const body = { fieldId: 'sig', dataUrl: DATA_URL, signerName: 'Test Signer (FAKE)', signedAt: new Date().toISOString(), method: 'type' };
  assert.equal((await SIGN(req('sign', body), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver') } })).status, 403);
  assert.equal((await SIGN(req('sign', { ...body, dataUrl: 'data:image/png;base64,AAAA' }), { params: { id: PID }, deps: { sb, mkUserClient: uc('dispatcher') } })).status, 422);
  assert.equal((await SIGN(req('sign', { ...body, fieldId: 'nm' }), { params: { id: PID }, deps: { sb, mkUserClient: uc('dispatcher') } })).status, 400);
  const r = await SIGN(req('sign', body), { params: { id: PID }, deps: { sb, mkUserClient: uc('dispatcher'), ts: 7 } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(sb.uploads, [`owner1/packets/signatures/${PID}/sig-7.png`]);
  const sig = j.fields.find((f) => f.id === 'sig'); assert.equal(sig.signed, true); assert.equal(sig.signer_name, 'Test Signer (FAKE)');
  assert.equal(j.fields.find((f) => f.id === 'dt').value, j.date);
  assert.equal(sb.tbl.packet_fields[0].signed_by, 'u-dispatcher');
  assert.ok(!JSON.stringify(j).includes('value_ciphertext'));
});

test('fill route: blocks unconfirmed bank + unsigned, then writes a new filled PDF with a download link', async () => {
  const d = await PDFDocument.create(); d.addPage([612, 792]);
  const sb = fakeSb({ packet: pkt(), fields: rowsFor(), profile: { owner_id: 'owner1', legal_name: 'Test Trucking Co (FAKE)' }, files: { 'owner1/packets/1-test.pdf': Buffer.from(await d.save()) } });
  const deps = (role, extra = {}) => ({ params: { id: PID }, deps: { sb, mkUserClient: uc(role), key: KEY, ts: 9, ...extra } });
  assert.equal((await FILL(req('fill'), deps('driver'))).status, 403);
  assert.equal((await FILL(req('fill'), deps('owner'))).status, 409); // bank not confirmed
  sb.tbl.packet_fields[3].confirmed_at = '2026-10-15T00:00:00Z';
  const unsigned = await FILL(req('fill'), deps('owner'));
  assert.equal(unsigned.status, 409); assert.equal((await unsigned.json()).missing[0].id, 'sig');
  sb.store['owner1/packets/signatures/s.png'] = PNG; Object.assign(sb.tbl.packet_fields[0], { signature_path: 'owner1/packets/signatures/s.png', signed_at: '2026-10-15T18:00:00Z' });
  const r = await FILL(req('fill'), deps('management'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.path, `owner1/packets/filled/${PID}-9.pdf`); assert.equal(j.drawn, 4); assert.equal(j.filename, 'Test_Broker_Packet_FAKE_-filled.pdf');
  assert.match(j.url, /download=Test_Broker_Packet_FAKE_-filled\.pdf/);
  assert.equal(sb.tbl.packets[0].filled_path, j.path);
  assert.equal((await PDFDocument.load(sb.store[j.path])).getPageCount(), 1);
  assert.ok(!JSON.stringify(j).includes('000123456789'));
});

test('adapter re-exports Casey\'s pad (real props); mapper drags with Pointer Events, editors only', () => {
  const ad = readFileSync(new URL('../../app/components/PacketSignaturePad.js', import.meta.url), 'utf8');
  assert.equal(ad.split('\n').filter((l) => /^export /.test(l)).length, 1);
  assert.match(ad, /^export \{ default \} from '\.\/SignaturePad';$/m);
  const pad = readFileSync(new URL('../../app/components/SignaturePad.js', import.meta.url), 'utf8');
  assert.match(pad, /export default function SignaturePad\(\{ onDone, onCancel, initialName = '', title = 'Sign here' \}\)/);
  const m = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
  assert.match(m, /onPointerDown=\{canEdit \? /); assert.match(m, /touchAction: canEdit \? 'none' : 'auto'/); assert.match(m, /canEdit && sel === f\.id && <span role="presentation" data-resize/);
});

test('Casey\'s pad payload is accepted as-is by the sign route parser', () => {
  for (const method of ['draw', 'type']) {
    const p = buildSignaturePayload({ dataUrl: DATA_URL, signerName: 'Test Signer (FAKE)', method });
    assert.deepEqual(Object.keys(p).sort(), ['dataUrl', 'method', 'signedAt', 'signerName']);
    const r = parseSignature(p);
    assert.equal(r.error, undefined); assert.equal(r.method, method); assert.equal(r.signedAt, p.signedAt); assert.equal(r.signerName, 'Test Signer (FAKE)');
  }
});
