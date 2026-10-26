// Load export email Send (Marc, Oct 25). Fake data and a fake sender only: no Postmark, no network, no real mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fakeSupabase } from './fakeSupabase.mjs';
import { sendEmailText, accountingRecipients, SEND_MAX_BYTES } from '../../app/lib/loadExport.js';
import * as SEND from '../../app/api/loads/[id]/send/route.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1', DISP = '00000000-0000-4000-8000-0000000000a5', DRIVER = '00000000-0000-4000-8000-0000000000a2';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const K1 = '00000000-0000-4000-8000-00000000c001', K2 = '00000000-0000-4000-8000-00000000c002';
const ENV = { POSTMARK_SERVER_TOKEN: 'fake-token', PACKET_FROM_EMAIL: 'noreply@fstrucks.com', EMAIL_MONTHLY_CAP: '80' };
async function onePagePdf() { const d = await PDFDocument.create(); d.addPage([612, 792]); return new Uint8Array(await d.save()); }

async function ctx(role, userId, { status = 'delivered', missing = [], sends = [], env = ENV, brokers = [] } = {}) {
  const files = { [`${OWNER}/1-rc.pdf`]: await onePagePdf() };
  const tables = {
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }], invoices: [], brokers, factors: [], packet_sends: [], coi_requests: [], load_packet_sends: sends,
    loads: [{ id: L1, user_id: OWNER, status, rate: 990, broker_name: 'Fake Broker', broker_load_number: 'TEST-146', notes: '', stops: [] }],
    documents: [{ id: 'd1', doc_type: 'rate_confirmation', file_path: `${OWNER}/1-rc.pdf`, original_filename: 'rc.pdf', created_at: '1', user_id: OWNER, load_id: L1 }], stop_delays: [],
  };
  const svc = fakeSupabase({ tables, missing });
  svc.storage.from = () => ({ download: async (p) => (files[p] ? { data: new Blob([files[p]]) } : { data: null }) });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }) };
  const mails = [];
  const send = async (m) => { mails.push(m); return { messageId: `fake-msg-${mails.length}` }; };
  return { svc, mails, files, deps: { mkUserClient: () => uc, sb: svc, env, send } };
}
const body = (o = {}) => ({ to: 'dispatch-test@fstrucks.com', note: 'FAKE note', sel: { invoice: true, docIds: ['d1'] }, idempotencyKey: K1, confirm: true, ...o });
const post = (c, o) => SEND.POST(new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body(o)) }), { params: { id: L1 }, deps: c.deps });
const get = (c) => SEND.GET(new Request('http://x/api', { headers: { authorization: 'Bearer t' } }), { params: { id: L1 }, deps: c.deps });

test('success: dispatcher sends one PDF via the fake sender; row claimed then message id recorded; no CC, not from marc@', async () => {
  const c = await ctx('dispatcher', DISP);
  const r = await post(c); const j = await r.json();
  assert.equal(r.status, 200, j.error); assert.equal(j.ok, true);
  assert.equal(c.mails.length, 1);
  const m = c.mails[0];
  assert.deepEqual(m.to, ['dispatch-test@fstrucks.com']); assert.deepEqual(m.cc, []);
  assert.equal(m.from, 'noreply@fstrucks.com'); assert.notEqual(m.replyTo, 'marc@fstrucks.com');
  assert.match(m.filename, /\.pdf$/); assert.equal(j.filename, m.filename);
  assert.match(m.body, /FAKE note/);
  const row = c.svc._db?.load_packet_sends?.[0] || (await c.svc.from('load_packet_sends').select('*').eq('id', K1).maybeSingle()).data;
  assert.equal(row.id, K1); assert.equal(row.load_id, L1); assert.equal(row.owner_id, OWNER); assert.equal(row.sent_by, DISP);
  assert.equal(row.with_invoice, true); assert.equal(row.postmark_message_id, 'fake-msg-1'); assert.ok(row.size_bytes > 0); assert.equal(row.note, 'FAKE note');
  assert.equal(j.sends.length, 1); assert.equal(j.sends[0].by, 'You');
});

test('duplicate id: same key twice → sent once; second gets the earlier result', async () => {
  const c = await ctx('owner', OWNER);
  assert.equal((await post(c)).status, 200);
  const r = await post(c); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.duplicate, true); assert.equal(c.mails.length, 1);
  const pending = await ctx('owner', OWNER, { sends: [{ id: K2, owner_id: OWNER, load_id: L1, sent_at: new Date().toISOString(), to_emails: ['x@fstrucks.com'], postmark_message_id: null }] });
  const p = await post(pending, { idempotencyKey: K2 });
  assert.equal(p.status, 409); assert.equal((await p.json()).pending, true); assert.equal(pending.mails.length, 0);
});

test('allow-list: outside domain refused (403) with the address named; default fstrucks.com is not widened', async () => {
  const c = await ctx('owner', OWNER);
  const r = await post(c, { to: 'someone@fake-broker.example' }); const j = await r.json();
  assert.equal(r.status, 403); assert.deepEqual(j.blocked, ['someone@fake-broker.example']); assert.match(j.error, /limited to fstrucks\.com/);
  assert.equal(c.mails.length, 0);
});

test('accounting address needs the extra confirm', async () => {
  const c = await ctx('owner', OWNER);
  const r = await post(c, { to: 'ap@fstrucks.com' }); const j = await r.json();
  assert.equal(r.status, 409); assert.equal(j.accountingConfirm, true); assert.equal(c.mails.length, 0);
  assert.equal((await post(c, { to: 'ap@fstrucks.com', confirmAccounting: true })).status, 200);
  assert.equal(c.mails.length, 1);
  assert.deepEqual(accountingRecipients(['billing@x.com', 'jane@x.com', 'payables@x.com', 'invoices@x.com', 'ar@x.com', 'accounting@x.com']), ['billing@x.com', 'payables@x.com', 'invoices@x.com', 'ar@x.com', 'accounting@x.com']);
});

test('no Postmark token → 503, nothing sent; marc@ as From → 503', async () => {
  const c = await ctx('owner', OWNER, { env: { ...ENV, POSTMARK_SERVER_TOKEN: '' } });
  const r = await post(c); const j = await r.json();
  assert.equal(r.status, 503); assert.match(j.error, /Email sending isn’t set up yet.*Nothing was sent/); assert.equal(c.mails.length, 0);
  const m = await ctx('owner', OWNER, { env: { ...ENV, PACKET_FROM_EMAIL: 'marc@fstrucks.com' } });
  assert.equal((await post(m)).status, 503); assert.equal(m.mails.length, 0);
});

test('missing table → 503 setup message, nothing sent; GET degrades with setupNeeded', async () => {
  const c = await ctx('owner', OWNER, { missing: ['load_packet_sends'] });
  const r = await post(c); const j = await r.json();
  assert.equal(r.status, 503); assert.equal(j.setupNeeded, true); assert.equal(c.mails.length, 0);
  const g = await get(c); const gj = await g.json();
  assert.equal(g.status, 200); assert.equal(gj.setupNeeded, true); assert.deepEqual(gj.sends, []);
});

test('cap reached → 429, nothing sent; load sends count toward it', async () => {
  const c = await ctx('owner', OWNER, { env: { ...ENV, EMAIL_MONTHLY_CAP: '1' }, sends: [{ id: K2, owner_id: OWNER, load_id: L1, sent_at: new Date().toISOString(), to_emails: ['x@fstrucks.com'], postmark_message_id: 'old' }] });
  const r = await post(c); assert.equal(r.status, 429); assert.equal((await r.json()).capReached, true); assert.equal(c.mails.length, 0);
});

test('driver 403; booked / cancelled 409', async () => {
  const d = await ctx('driver', DRIVER);
  assert.equal((await post(d)).status, 403); assert.equal((await get(d)).status, 403); assert.equal(d.mails.length, 0);
  for (const status of ['booked', 'cancelled', 'in_transit']) {
    const c = await ctx('owner', OWNER, { status });
    assert.equal((await post(c)).status, 409, status); assert.equal(c.mails.length, 0);
  }
});

test('oversize PDF (limit is 7.5 MB raw) → 413 tooLarge, nothing sent, no row claimed', async () => {
  const c = await ctx('owner', OWNER);
  c.deps.maxBytes = 500; // the real limit is SEND_MAX_BYTES (7.5 MB raw ≈ Postmark's 10 MB encoded)
  const r = await post(c, { sel: { invoice: false, docIds: ['d1'] } }); const j = await r.json();
  assert.equal(r.status, 413, j.error); assert.equal(j.tooLarge, true); assert.equal(SEND_MAX_BYTES, 7_500_000); assert.equal(c.mails.length, 0);
  assert.equal((await c.svc.from('load_packet_sends').select('*').eq('id', K1).maybeSingle()).data, null);
});

test('sender refuses → claim released; unknown result keeps the claim', async () => {
  const c = await ctx('owner', OWNER);
  c.deps.send = async () => ({ error: 'refused', code: 406 });
  assert.equal((await post(c)).status, 502);
  assert.equal((await c.svc.from('load_packet_sends').select('*').eq('id', K1).maybeSingle()).data, null);
  c.deps.send = async () => ({ error: 'lost', unknown: true });
  assert.equal((await post(c)).status, 504);
  assert.ok((await c.svc.from('load_packet_sends').select('*').eq('id', K1).maybeSingle()).data);
});

test('GET: history (who/to/when/invoice), prefill skips accounting, config flags; must confirm', async () => {
  const c = await ctx('management', OWNER, { brokers: [{ id: 'b1', owner_id: OWNER, name: 'Fake Broker', billing_emails: ['billing@fstrucks.com', 'jane-test@fstrucks.com'] }],
    sends: [{ id: K2, owner_id: OWNER, load_id: L1, sent_by: OWNER, sent_at: '2026-10-25T12:00:00Z', to_emails: ['x@fstrucks.com'], with_invoice: false, postmark_message_id: 'm' }] });
  const j = await (await get(c)).json();
  assert.equal(j.prefill, 'jane-test@fstrucks.com'); assert.equal(j.configured, true); assert.deepEqual(j.allowedDomains, ['fstrucks.com']); assert.equal(j.maxBytes, SEND_MAX_BYTES);
  assert.deepEqual(j.sends.map((s) => [s.by, s.to[0], s.with_invoice, s.confirmed]), [['You', 'x@fstrucks.com', false, true]]);
  assert.equal((await post(c, { confirm: false })).status, 400); assert.equal(c.mails.length, 0);
});

test('static: route never calls real fetch in tests (send is injected); UI has explicit Send + confirm, no auto-send', () => {
  const ui = readFileSync(new URL('../../app/components/LoadExport.js', import.meta.url), 'utf8');
  assert.match(ui, /data-testid="load-export-confirm"/); assert.match(ui, /data-testid="load-export-send"/);
  assert.doesNotMatch(ui, /\b(bot|AI)\b/);
  assert.match(sendEmailText({ load: { broker_load_number: 'T-1' }, companyName: 'FAKE', withInvoice: true }).subject, /Load T-1 paperwork and invoice/);
});

// Taylor's QA of #153 (5): authenticated role × status matrix on the send route (fake bearer user, fake sender).
test('send matrix: office roles send when delivered/invoiced/paid; driver 403 always; booked/cancelled 409; no real mail', async () => {
  const MGMT = '00000000-0000-4000-8000-0000000000a4';
  const office = [['owner', OWNER], ['management', MGMT], ['dispatcher', DISP]];
  for (const status of ['delivered', 'invoiced', 'paid']) for (const [role, uid] of office) {
    const c = await ctx(role, uid, { status });
    const r = await post(c, { idempotencyKey: K2 });
    assert.equal(r.status, 200, `${role} ${status}: ${(await r.clone().json()).error || ''}`); assert.equal(c.mails.length, 1);
  }
  for (const status of ['delivered', 'invoiced', 'paid', 'booked', 'cancelled']) {
    const d = await ctx('driver', DRIVER, { status });
    assert.equal((await post(d)).status, 403, `driver ${status}`); assert.equal((await get(d)).status, 403); assert.equal(d.mails.length, 0);
  }
  for (const status of ['booked', 'cancelled']) for (const [role, uid] of office) {
    const c = await ctx(role, uid, { status });
    assert.equal((await post(c)).status, 409, `${role} ${status}`); assert.equal((await get(c)).status, 409); assert.equal(c.mails.length, 0);
  }
});
