import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBasicAuth, parseInbound, emailOf, packetPath, PACKET_MAX_BYTES } from '../../app/lib/postmarkInbound.js';
import { createPacketReader, CONFIRM_KEYS } from '../../app/lib/packetReader.js';
import { validatePacketFile } from '../../app/lib/packetUpload.js';
import { POST } from '../../app/api/inbound/postmark/route.js';

const PDF = Buffer.from('%PDF-1.4\n% fake test packet\n').toString('base64');
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const payload = (over = {}) => ({
  From: 'Test Dispatch <dispatch@example.com>', FromFull: { Email: 'dispatch@example.com' }, To: 'packets@in.fstrucks.com', Cc: 'broker2@example.com',
  Subject: 'Carrier packet - Test Broker', MessageID: 'pm-1',
  Headers: [{ Name: 'Message-ID', Value: '<abc@example.com>' }, { Name: 'References', Value: '<r1@example.com>' }],
  Attachments: [{ Name: 'packet.pdf', ContentType: 'application/pdf', Content: PDF }, { Name: 'logo.png', ContentType: 'image/png', Content: 'iVBORw0K' }],
  ...over,
});

test('basic auth: unconfigured, wrong, right', () => {
  assert.deepEqual(checkBasicAuth(basic('a', 'b'), '', ''), { ok: false, configured: false });
  assert.equal(checkBasicAuth(null, 'u', 'p').ok, false);
  assert.equal(checkBasicAuth(basic('u', 'x'), 'u', 'p').ok, false);
  assert.equal(checkBasicAuth(basic('x', 'p'), 'u', 'p').ok, false);
  assert.equal(checkBasicAuth('Bearer zzz', 'u', 'p').ok, false);
  assert.equal(checkBasicAuth(basic('u', 'p:with:colons'), 'u', 'p:with:colons').ok, true);
});
test('emailOf parses display names', () => {
  assert.equal(emailOf('Test <A@Example.com>'), 'a@example.com');
  assert.equal(emailOf('b@example.com'), 'b@example.com');
  assert.equal(emailOf('nobody'), null);
});
test('parseInbound keeps PDFs, rejects non-PDF, fake-PDF, oversize', () => {
  const big = Buffer.alloc(PACKET_MAX_BYTES + 1, 0x20); big.write('%PDF-');
  const m = parseInbound(payload({ Attachments: [...payload().Attachments, { Name: 'x.pdf', ContentType: 'application/pdf', Content: Buffer.from('not a pdf').toString('base64') }, { Name: 'big.pdf', ContentType: 'application/pdf', Content: big.toString('base64') }] }));
  assert.equal(m.fromEmail, 'dispatch@example.com');
  assert.equal(m.messageId, '<abc@example.com>');
  assert.equal(m.references, '<r1@example.com>');
  assert.equal(m.pdfs.length, 1);
  assert.deepEqual(m.rejected.map((r) => r.reason), ['not_pdf', 'not_pdf', 'too_large']);
  assert.throws(() => parseInbound({}), /sender/);
});
test('packetPath is owner-scoped and sanitized', () => {
  assert.equal(packetPath('own1', '../evil name.pdf', 5, 1), 'own1/packets/5-1-.._evil_name.pdf');
  assert.ok(!packetPath('o', 'a/b.pdf', 1).slice(2).includes('/b'));
});

function fakeSb({ owner = 'owner-1', dup = false } = {}) {
  const calls = { inserts: [], uploads: [], rpc: [] };
  const sb = {
    calls,
    rpc: async (fn, args) => { calls.rpc.push([fn, args]); return { data: owner, error: null }; },
    storage: { from: () => ({ upload: async (p) => { calls.uploads.push(p); return { error: null }; }, remove: async () => ({}) }) },
    from: (t) => ({
      select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: dup ? { id: 'x' } : null }),
      insert(row) { calls.inserts.push([t, row]); return { select: () => ({ single: async () => ({ data: { id: 'email-1' }, error: null }) }), then: (r) => r({ error: null }) }; },
    }),
  };
  return sb;
}
const req = (auth, body) => new Request('http://x/api/inbound/postmark', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
function withEnv(fn) {
  return async () => {
    process.env.POSTMARK_INBOUND_USER = 'test-user'; process.env.POSTMARK_INBOUND_PASSWORD = 'test-pass';
    try { await fn(); } finally { delete process.env.POSTMARK_INBOUND_USER; delete process.env.POSTMARK_INBOUND_PASSWORD; }
  };
}

test('webhook: 503 when creds not configured', async () => {
  const r = await POST(req(basic('a', 'b'), payload()), { deps: { supabase: fakeSb() } });
  assert.equal(r.status, 503);
});
test('webhook: 401 on bad auth, nothing stored', withEnv(async () => {
  const sb = fakeSb();
  const r = await POST(req(basic('test-user', 'nope'), payload()), { deps: { supabase: sb } });
  assert.equal(r.status, 401); assert.equal(sb.calls.inserts.length, 0);
}));
test('webhook: matched sender → email row + packet per PDF in owner path', withEnv(async () => {
  const sb = fakeSb();
  const r = await POST(req(basic('test-user', 'test-pass'), payload()), { deps: { supabase: sb } });
  const j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual([j.matched, j.packets, j.rejected], [true, 1, 1]);
  assert.deepEqual(sb.calls.rpc[0], ['packet_owner_for_email', { p_email: 'dispatch@example.com' }]);
  assert.match(sb.calls.uploads[0], /^owner-1\/packets\/\d+-0-packet\.pdf$/);
  const pkt = sb.calls.inserts.find(([t]) => t === 'packets')[1];
  assert.deepEqual([pkt.owner_id, pkt.source, pkt.inbound_email_id, pkt.status], ['owner-1', 'email', 'email-1', 'received']);
}));
test('webhook: unmatched sender logged, no files', withEnv(async () => {
  const sb = fakeSb({ owner: null });
  const j = await (await POST(req(basic('test-user', 'test-pass'), payload()), { deps: { supabase: sb } })).json();
  assert.equal(j.matched, false); assert.equal(sb.calls.uploads.length, 0);
  assert.equal(sb.calls.inserts[0][1].status, 'unmatched');
}));
test('webhook: duplicate Message-ID is a no-op', withEnv(async () => {
  const sb = fakeSb({ dup: true });
  const j = await (await POST(req(basic('test-user', 'test-pass'), payload()), { deps: { supabase: sb } })).json();
  assert.equal(j.duplicate, true); assert.equal(sb.calls.inserts.length, 0);
}));

test('reader: skipped with no key, never calls transport', async () => {
  let called = false;
  const r = createPacketReader({ apiKey: '', transport: async () => { called = true; } });
  assert.equal(r.enabled, false);
  const out = await r.nameFields([{ id: 'f1', label: 'Legal name' }]);
  assert.equal(out.skipped, true); assert.equal(called, false); assert.equal(out.fields[0].profile_key, null);
});
test('reader: mocked transport, gpt-4.1-mini, bank fields need confirm, no values sent', async () => {
  let sent;
  const r = createPacketReader({ apiKey: 'test-not-real', transport: async ({ body }) => { sent = body; return { fields: [
    { id: 'f1', profile_key: 'legal_name', confidence: 0.9 }, { id: 'f2', profile_key: 'bank_account', confidence: 2 }, { id: 'f3', profile_key: 'bogus', confidence: 0.5 }] }; } });
  const out = await r.nameFields([{ id: 'f1', page: 1, label: 'Company', kind: 'text', box: [1, 2, 3, 4], value: 'SECRET' }, { id: 'f2', label: 'Account #' }, { id: 'f3', label: '?' }]);
  assert.equal(sent.model, 'gpt-4.1-mini');
  assert.ok(!JSON.stringify(sent).includes('SECRET'));
  assert.deepEqual(out.fields.map((f) => [f.profile_key, f.needs_confirm, f.confidence]), [['legal_name', false, 0.9], ['bank_account', true, 1], [null, false, 0.5]]);
  assert.ok(CONFIRM_KEYS.has('bank_routing'));
});
test('upload validation', () => {
  assert.match(validatePacketFile(null), /Choose/);
  assert.match(validatePacketFile({ name: 'a.png', type: 'image/png', size: 1 }), /PDF/);
  assert.match(validatePacketFile({ name: 'a.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 }), /10 MB/);
  assert.equal(validatePacketFile({ name: 'a.pdf', type: 'application/pdf', size: 100 }), null);
});
test('packets page iOS-safe picker; migration additive with RLS', () => {
  const page = readFileSync(new URL('../../app/packets/page.js', import.meta.url), 'utf8');
  assert.match(page, /<input id=\{FILE_ID\} type="file"[^>]*style=\{VISUALLY_HIDDEN\}/);
  assert.match(page, /<label htmlFor=\{FILE_ID\}/);
  assert.ok(!/display:\s*['"]?none/.test(page) && !/\.click\(\)/.test(page));
  const sql = readFileSync(new URL('../../supabase/migrations/20261015001300_packets_inbound.sql', import.meta.url), 'utf8').toLowerCase();
  assert.ok(!/\b(drop table|drop column|truncate|delete from|update public\.)/.test(sql));
  for (const x of ['alter table public.packets enable row level security', 'alter table public.inbound_emails enable row level security', 'packet_owner_for_email', 'unique (provider, message_id)'])
    assert.ok(sql.includes(x), x);
  assert.ok(!/openai/i.test(readFileSync(new URL('../../app/api/inbound/postmark/route.js', import.meta.url), 'utf8')));
});
