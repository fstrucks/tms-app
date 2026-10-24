// Rate con email-in (ratecon+<token>@in.fstrucks.com) through the existing Postmark route.
// FAKE Postmark payloads and FAKE PDFs only (no real rate cons); no network, no OpenAI, no Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POST } from '../../app/api/inbound/postmark/route.js';
import { rateconRecipient, senderAllowed, rateconPath, extractEmailRateCon } from '../../app/lib/rateconEmail.js';
import { emailDraftState, isEmailDraft, rateconAddress, parseSenders, emailReadProblem } from '../../app/lib/rateconDrafts.js';
import { fakeSupabase } from './fakeSupabase.mjs';

const TOKEN = 'a'.repeat(31) + 'b';
const OTHER = 'c'.repeat(32);
const USER = '00000000-0000-4000-8000-0000000000aa';
const fakePdf = (label = 'FAKE TEST RATE CON') => Buffer.from(`%PDF-1.4\n% ${label} - not a real document\n%%EOF\n`).toString('base64');
const basic = 'Basic ' + Buffer.from('test-user:test-pass').toString('base64');
const payload = (over = {}) => ({
  From: 'Fake Broker <broker@example.com>', FromFull: { Email: 'broker@example.com' },
  To: `ratecon+${TOKEN}@in.fstrucks.com`, ToFull: [{ Email: `ratecon+${TOKEN}@in.fstrucks.com`, MailboxHash: TOKEN }],
  OriginalRecipient: `ratecon+${TOKEN}@in.fstrucks.com`, MailboxHash: TOKEN,
  Subject: 'FAKE Rate Confirmation #TEST-1', MessageID: 'pm-rc-1', TextBody: 'fake body',
  Headers: [{ Name: 'Message-ID', Value: '<fake-rc-1@example.com>' }],
  Attachments: [{ Name: 'FAKE-ratecon.pdf', ContentType: 'application/pdf', Content: fakePdf() }],
  ...over,
});

function sbWith({ owners = { [TOKEN]: { user_id: USER, allowed_senders: [] } }, uploadFail = false, slot = 'run-1' } = {}) {
  const sb = fakeSupabase({ tables: { inbound_emails: [], documents: [], extraction_runs: [] }, unique: { inbound_emails: [{ cols: ['provider', 'message_id'] }] } });
  sb.uploads = []; sb.removed = []; sb.rpcCalls = [];
  sb.rpc = async (fn, args) => {
    sb.rpcCalls.push([fn, args]);
    if (fn === 'ratecon_owner_for_token') return { data: owners[args.p_token] ? [owners[args.p_token]] : [], error: null };
    if (fn === 'claim_extraction_slot') return { data: slot, error: null };
    return { data: null, error: null };
  };
  sb.storage = { from: () => ({
    upload: async (p) => { if (uploadFail) return { error: { message: 'boom' } }; sb.uploads.push(p); return { error: null }; },
    remove: async (ps) => { sb.removed.push(...ps); return {}; },
  }) };
  return sb;
}
const req = (body) => new Request('http://x/api/inbound/postmark', { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function send(sb, body, extra = {}) {
  process.env.POSTMARK_INBOUND_USER = 'test-user'; process.env.POSTMARK_INBOUND_PASSWORD = 'test-pass';
  const pending = []; const extracted = [];
  try {
    const r = await POST(req(body), { deps: { supabase: sb, waitUntil: (p) => pending.push(p), ratecon: { extract: async (a) => { extracted.push(a); }, now: () => 1700000000000, ...extra } } });
    await Promise.all(pending);
    return { status: r.status, body: await r.json(), extracted };
  } finally { delete process.env.POSTMARK_INBOUND_USER; delete process.env.POSTMARK_INBOUND_PASSWORD; }
}

test('recipient parsing: ratecon+token in To/ToFull/OriginalRecipient/Cc, case-insensitive; packets@ is not rate con', () => {
  assert.deepEqual(rateconRecipient(payload()), { token: TOKEN });
  assert.deepEqual(rateconRecipient({ To: `Rates <RATECON+${TOKEN.toUpperCase()}@IN.FSTRUCKS.COM>` }), { token: TOKEN });
  assert.deepEqual(rateconRecipient({ To: 'me@example.com', Cc: `x@example.com, ratecon+${TOKEN}@in.fstrucks.com` }), { token: TOKEN });
  assert.deepEqual(rateconRecipient({ To: 'ratecon@in.fstrucks.com' }), { token: null });
  assert.deepEqual(rateconRecipient({ To: 'ratecon+short@in.fstrucks.com' }), { token: null });
  assert.equal(rateconRecipient({ To: 'packets@in.fstrucks.com' }), null);
  assert.equal(rateconRecipient({ To: `ratecon+${TOKEN}@evil.example.com` }), null);
});
test('sender allowlist: empty = anyone; emails and @domains', () => {
  assert.equal(senderAllowed([], 'x@y.com'), true);
  assert.equal(senderAllowed(['broker@example.com'], 'Broker@Example.com'), true);
  assert.equal(senderAllowed(['@example.com'], 'ops@example.com'), true);
  assert.equal(senderAllowed(['@example.com'], 'ops@notexample.com'), false);
  assert.deepEqual(parseSenders('A@x.com, @y.com\n\n z@w.io'), ['a@x.com', '@y.com', 'z@w.io']);
});

test('one PDF → one email-sourced rate con document in the user folder, extraction queued, no load', async () => {
  const sb = sbWith();
  const r = await send(sb, payload());
  assert.equal(r.status, 200); assert.deepEqual([r.body.matched, r.body.ratecons, r.body.rejected], [true, 1, 0]);
  assert.match(sb.uploads[0], new RegExp(`^${USER}/ratecons/email-1700000000000-0-FAKE-ratecon\\.pdf$`));
  const [doc] = sb.db.documents;
  assert.deepEqual([doc.user_id, doc.doc_type, doc.source, doc.extraction_status, doc.load_id], [USER, 'rate_confirmation', 'email', 'pending', undefined]);
  const [em] = sb.db.inbound_emails;
  assert.deepEqual([em.kind, em.status, em.owner_id, em.message_id, em.to_emails], ['ratecon', 'matched', USER, 'ratecon:pm-rc-1', null]);
  assert.equal(r.extracted.length, 1); assert.equal(r.extracted[0].docId, doc.id);
  assert.ok(!sb.calls.some((c) => c.t === 'loads' || c.t === 'packets'), 'never creates a load or a packet');
  assert.ok(!sb.rpcCalls.some(([fn]) => fn === 'packet_owner_for_email'), 'skips packet sender matching');
});
test('multiple PDFs → one draft each; non-PDF, fake .pdf and oversize recorded as skipped', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20); big.write('%PDF-');
  const sb = sbWith();
  const r = await send(sb, payload({ Attachments: [
    { Name: 'FAKE-a.pdf', ContentType: 'application/pdf', Content: fakePdf('A') },
    { Name: 'FAKE-b.pdf', ContentType: 'application/octet-stream', Content: fakePdf('B') },
    { Name: 'notes.docx', ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Content: Buffer.from('PK fake').toString('base64') },
    { Name: 'renamed.pdf', ContentType: 'application/pdf', Content: Buffer.from('not a pdf').toString('base64') },
    { Name: 'huge.pdf', ContentType: 'application/pdf', Content: big.toString('base64') },
  ] }));
  assert.deepEqual([r.body.ratecons, r.body.rejected], [2, 3]);
  assert.equal(sb.db.documents.length, 2); assert.equal(r.extracted.length, 2);
  assert.deepEqual(sb.db.inbound_emails[0].rejected_attachments.map((x) => x.reason), ['not_pdf', 'not_pdf', 'too_large']);
});
test('no PDFs at all → email logged as rejected, nothing stored', async () => {
  const sb = sbWith();
  const r = await send(sb, payload({ Attachments: [{ Name: 'photo.jpg', ContentType: 'image/jpeg', Content: Buffer.from('fakejpg').toString('base64') }] }));
  assert.equal(r.status, 200); assert.equal(r.body.ratecons, 0);
  assert.equal(sb.db.inbound_emails[0].status, 'rejected'); assert.equal(sb.db.documents.length, 0); assert.equal(sb.uploads.length, 0);
});
test('unknown or rotated token → 200, dropped quietly (no owner, no files, no bounce)', async () => {
  for (const to of [`ratecon+${OTHER}@in.fstrucks.com`, 'ratecon@in.fstrucks.com', 'ratecon+nope@in.fstrucks.com']) {
    const sb = sbWith();
    const r = await send(sb, payload({ To: to, ToFull: [{ Email: to }], OriginalRecipient: to }));
    assert.equal(r.status, 200, to); assert.equal(r.body.matched, false);
    assert.equal(sb.uploads.length, 0); assert.equal(sb.db.documents.length, 0);
    assert.deepEqual([sb.db.inbound_emails[0].status, sb.db.inbound_emails[0].owner_id, sb.db.inbound_emails[0].kind], ['unmatched', null, 'ratecon']);
  }
});
test('sender not on the allowlist → dropped quietly; on the list → accepted', async () => {
  const owners = { [TOKEN]: { user_id: USER, allowed_senders: ['@trusted.example'] } };
  let sb = sbWith({ owners });
  let r = await send(sb, payload());
  assert.equal(r.body.matched, false); assert.equal(sb.db.documents.length, 0);
  sb = sbWith({ owners });
  r = await send(sb, payload({ From: 'ops@trusted.example', FromFull: { Email: 'ops@trusted.example' } }));
  assert.equal(r.body.ratecons, 1);
});
test('duplicate Postmark MessageID → no-op (pre-check and insert race)', async () => {
  const sb = sbWith();
  await send(sb, payload());
  const again = await send(sb, payload());
  assert.equal(again.body.duplicate, true); assert.equal(sb.db.documents.length, 1); assert.equal(sb.uploads.length, 1);
  // Race: the pre-check misses, the insert hits the unique key.
  const sb2 = sbWith();
  const orig = sb2.from;
  let first = true;
  sb2.from = (t) => { const q = orig(t); if (t === 'inbound_emails' && first) { first = false; q.maybeSingle = async () => ({ data: null, error: null }); sb2.db.inbound_emails.push({ id: 'x', provider: 'postmark', message_id: 'ratecon:pm-rc-1' }); } return q; };
  const raced = await send(sb2, payload());
  assert.equal(raced.body.duplicate, true); assert.equal(sb2.db.documents.length, 0);
});
test('a different MessageID with the same Message-ID header is a new email (dedupe on Postmark MessageID; a different PDF so the content dedupe does not apply)', async () => {
  const sb = sbWith();
  await send(sb, payload());
  const r = await send(sb, payload({ MessageID: 'pm-rc-2', Attachments: [{ Name: 'FAKE-ratecon-2.pdf', ContentType: 'application/pdf', Content: fakePdf('SECOND') }] }));
  assert.equal(r.body.ratecons, 1); assert.equal(sb.db.documents.length, 2);
});
test('upload failure skips that PDF without a half-made document', async () => {
  const sb = sbWith({ uploadFail: true });
  const r = await send(sb, payload());
  assert.equal(r.status, 200); assert.equal(r.body.ratecons, 0); assert.equal(sb.db.documents.length, 0);
});
test('packets@ mail still goes down the packet path', async () => {
  const sb = sbWith();
  sb.rpc = async (fn) => { sb.rpcCalls.push([fn]); return { data: null, error: null }; };
  const r = await send(sb, payload({ To: 'packets@in.fstrucks.com', ToFull: [{ Email: 'packets@in.fstrucks.com' }], OriginalRecipient: 'packets@in.fstrucks.com' }));
  assert.equal(r.body.matched, false); assert.deepEqual(sb.rpcCalls.map(([f]) => f), ['packet_owner_for_email']);
});

// ---- extraction on the server (model mocked) ----
const docSb = (slot) => { const sb = sbWith({ slot }); sb.db.documents.push({ id: 'd1', user_id: USER, extraction_status: 'pending' }); return sb; };
const rc = { document_kind: 'rate_confirmation', heading_text: 'RATE CONFIRMATION', broker_name: 'FAKE Freight', load_number: 'TEST-1', reference_numbers: null,
  shipper: null, receiver: null, pickup: { date: '2026-10-20', time: null, address: 'Dallas, TX' }, delivery: { date: '2026-10-21', time: null, address: 'Austin, TX' },
  rate: 1234, equipment_type: 'Dry van', weight: '38,500 lbs', total_miles: 196, notes: null };
const run = (sb, callModel, env = { OPENAI_API_KEY: 'test-not-real' }) => extractEmailRateCon({ sb, userId: USER, docId: 'd1', bytes: Buffer.from(fakePdf(), 'base64'), name: 'FAKE.pdf',
  deps: { env, pdfText: async () => '', callModel } });

test('extraction success → ai_extracted_data saved, status done (still a draft: no load)', async () => {
  const sb = docSb('run-1');
  await run(sb, async () => ({ ok: true, extracted: rc }));
  const d = sb.db.documents[0];
  assert.equal(d.extraction_status, 'done'); assert.equal(d.ai_extracted_data.rate, 1234); assert.equal(d.ai_extracted_data.weight_lb, 38500);
  assert.equal(d.ai_extracted_data.document_kind, undefined); assert.equal(d.load_id, undefined);
  assert.deepEqual(sb.rpcCalls.find(([f]) => f === 'claim_extraction_slot')[1], { p_user: USER, p_document: 'd1' });
});
test('extraction failures keep the file and mark it for manual entry', async () => {
  for (const [label, slot, model, env, reason] of [
    ['model error', 'run-1', async () => ({ ok: false, status: 'error', log: ['OpenAI', 500] }), undefined, 'error'],
    ['timeout', 'run-1', async () => ({ ok: false, status: 'timeout', log: [] }), undefined, 'timeout'],
    ['rate limit', null, async () => { throw new Error('should not call'); }, undefined, 'rate_limited'],
    ['no key', 'run-1', async () => { throw new Error('should not call'); }, {}, 'not_configured'],
    ['not a rate con', 'run-1', async () => ({ ok: true, extracted: { ...rc, document_kind: 'other' } }), undefined, 'not_ratecon'],
    ['nothing read', 'run-1', async () => ({ ok: true, extracted: { ...rc, broker_name: null, rate: null, pickup: null, delivery: null } }), undefined, 'nothing_read'],
  ]) {
    const sb = docSb(slot);
    await run(sb, model, env);
    const d = sb.db.documents[0];
    assert.deepEqual([d.extraction_status, d.extraction_error], ['failed', reason], label);
    assert.equal(sb.removed.length, 0, `${label}: file kept`);
  }
});

test('draft state for the UI', () => {
  const now = Date.parse('2026-10-19T20:00:00Z');
  const base = { source: 'email', doc_type: 'rate_confirmation', created_at: '2026-10-19T19:59:00Z' };
  assert.equal(emailDraftState({ ...base, extraction_status: 'pending' }, now), 'reading');
  assert.equal(emailDraftState({ ...base, extraction_status: 'pending', created_at: '2026-10-19T19:00:00Z' }, now), 'manual', 'stuck pending → manual');
  assert.equal(emailDraftState({ ...base, extraction_status: 'failed' }, now), 'manual');
  assert.equal(emailDraftState({ ...base, extraction_status: 'failed', ai_extracted_data: { rate: 1 } }, now), 'ready', 'Run extraction later fixes it');
  assert.equal(emailDraftState({ ...base, ai_extracted_data: {}, load_id: 'L1' }, now), null, 'confirmed → no longer a draft');
  assert.equal(emailDraftState({ ...base, source: 'upload' }, now), null);
  assert.equal(isEmailDraft({ ...base }), true); assert.equal(isEmailDraft({ ...base, load_id: 'x' }), false);
  assert.equal(rateconAddress(TOKEN), `ratecon+${TOKEN}@in.fstrucks.com`);
  assert.match(emailReadProblem('rate_limited'), /hourly limit/); assert.match(emailReadProblem('whatever'), /by hand/);
  assert.match(rateconPath(USER, '../x y.pdf', 5, 1), new RegExp(`^${USER}/ratecons/email-5-1-\\.\\._x_y\\.pdf$`));
});

test('wiring: route branches before packet matching; Documents badge, review, manual entry, address card; Loads banner; tokens only', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const route = read('../../app/api/inbound/postmark/route.js');
  assert.ok(route.indexOf('rateconRecipient(payload)') < route.indexOf("rpc('packet_owner_for_email'"));
  const docs = read('../../app/documents/page.js');
  for (const x of ['From email', 'Needs manual entry', 'Enter load by hand', '<RateconEmailCard', 'Check these details against the PDF']) assert.ok(docs.includes(x), x);
  assert.ok(read('../../app/lib/docsInbox.js').includes("error?.code === '42703'"), 'email columns fall back when the migration is not applied yet');
  const card = read('../../app/components/RateconEmailCard.js');
  for (const x of ["rpc('ratecon_address_get')", "rpc('ratecon_address_regenerate')", "rpc('ratecon_set_allowed_senders'", 'Copy address', 'New address']) assert.ok(card.includes(x), x);
  assert.ok(read('../../app/loads/page.js').includes('<EmailDraftsBanner />'));
  for (const f of ['../../app/components/RateconEmailCard.js', '../../app/components/EmailDraftsBanner.js', '../../app/documents/page.js', '../../app/lib/rateconEmail.js', '../../app/lib/rateconDrafts.js'])
    assert.ok(!/#[0-9a-fA-F]{3,8}\b(?![^'"]*['"]\s*:)/.test(read(f).replace(/\/\/.*$/gm, '').replace(/#\d+/g, '')), `${f}: no hex colors`);
  const sql = read('../../supabase/migrations/20261019000200_ratecon_email_in.sql').toLowerCase();
  assert.ok(!/\b(drop table|drop column|truncate|delete from)\b/.test(sql));
  for (const x of ['enable row level security', 'ratecon_owner_for_token', "to service_role", 'documents_source_check']) assert.ok(sql.includes(x), x);
  assert.ok(!/postmark_server_token/i.test(read('../../app/lib/rateconEmail.js') + route));
});

// ---- #102 QA follow-ups ----
import { dedupeRateconPdfs, pdfSha256 } from '../../app/lib/rateconEmail.js';
import { isNotRatecon, skippedLine, visibleSkipped, readDismissed, addDismissed, copyText, REJECT_TEXT } from '../../app/lib/rateconDrafts.js';

test('dedupe: same PDF in a new email (new MessageID) → skipped as already received, no second draft', async () => {
  const sb = sbWith();
  const r1 = await send(sb, payload());
  assert.equal(r1.body.ratecons, 1);
  assert.match(sb.db.documents[0].content_sha256, /^[a-f0-9]{64}$/);
  const r2 = await send(sb, payload({ MessageID: 'pm-rc-2', Subject: 'FWD again' }));
  assert.deepEqual([r2.status, r2.body.ratecons, r2.body.duplicates], [200, 0, 1]);
  assert.equal(sb.db.documents.length, 1); assert.equal(sb.uploads.length, 1);
  const e2 = sb.db.inbound_emails[1];
  assert.equal(e2.status, 'rejected');
  assert.deepEqual(e2.rejected_attachments, [{ name: 'FAKE-ratecon.pdf', reason: 'duplicate' }]);
  assert.match(skippedLine(e2), /FAKE-ratecon\.pdf \(already received\)/);
});
test('dedupe: two identical PDFs in one email → one draft; a different PDF still goes through', async () => {
  const sb = sbWith();
  const r = await send(sb, payload({ Attachments: [
    { Name: 'A.pdf', ContentType: 'application/pdf', Content: fakePdf('A') },
    { Name: 'A-copy.pdf', ContentType: 'application/pdf', Content: fakePdf('A') },
    { Name: 'B.pdf', ContentType: 'application/pdf', Content: fakePdf('B') },
  ] }));
  assert.deepEqual([r.body.ratecons, r.body.duplicates], [2, 1]);
  assert.deepEqual(sb.db.inbound_emails[0].rejected_attachments, [{ name: 'A-copy.pdf', reason: 'duplicate' }]);
});
test('dedupe: another owner with the same PDF is not a duplicate; a deleted draft no longer blocks', async () => {
  const sb = sbWith({ owners: { [TOKEN]: { user_id: USER, allowed_senders: [] }, [OTHER]: { user_id: 'other-user', allowed_senders: [] } } });
  await send(sb, payload());
  const addr = `ratecon+${OTHER}@in.fstrucks.com`;
  const r = await send(sb, payload({ MessageID: 'pm-rc-o', To: addr, ToFull: [{ Email: addr }], OriginalRecipient: addr }));
  assert.equal(r.body.ratecons, 1);
  sb.db.documents = sb.db.documents.filter((d) => d.user_id !== USER);
  const r3 = await send(sb, payload({ MessageID: 'pm-rc-3' }));
  assert.equal(r3.body.ratecons, 1);
});
test('dedupe: missing hash column (migration not applied) → no dedupe and no hash written', async () => {
  const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: null, error: { code: '42703' } }) }) }) }) }) };
  const pdfs = [{ name: 'a.pdf', bytes: Buffer.from('x') }, { name: 'b.pdf', bytes: Buffer.from('x') }];
  const out = await dedupeRateconPdfs(sb, USER, pdfs);
  assert.equal(out.hashColumn, false); assert.equal(out.keep.length, 1); assert.equal(out.dups.length, 1);
  assert.equal(pdfSha256(Buffer.from('x')).length, 64);
});
test('oversize text names the limit; skipped line lists every reason', () => {
  assert.match(REJECT_TEXT.too_large, /10 MB limit/);
  assert.equal(skippedLine({ subject: 'S', rejected_attachments: [{ name: 'big.pdf', reason: 'too_large' }, { name: 'n.docx', reason: 'not_pdf' }] }),
    'Skipped from email “S”: big.pdf (over the 10 MB limit), n.docx (not a PDF)');
});
test('not-a-rate-con PDFs: own label, not counted as waiting', () => {
  const base = { source: 'email', load_id: null, doc_type: 'rate_confirmation' };
  const notRc = { ...base, extraction_status: 'failed', extraction_error: 'not_ratecon' };
  assert.equal(isNotRatecon(notRc), true); assert.equal(isEmailDraft(notRc), false);
  assert.equal(isEmailDraft({ ...base, extraction_status: 'failed', extraction_error: 'nothing_read' }), true);
  assert.equal(isNotRatecon({ ...notRc, load_id: 'L1' }), false);
});
test('skipped notices: dismiss persists per email id', () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const rows = [{ id: 'e1', rejected_attachments: [{ name: 'a', reason: 'not_pdf' }] }, { id: 'e2', rejected_attachments: [] }, { id: 'e3', rejected_attachments: [{ name: 'b', reason: 'duplicate' }] }];
  assert.deepEqual(visibleSkipped(rows, readDismissed(storage)).map((r) => r.id), ['e1', 'e3']);
  addDismissed(storage, ['e1']);
  assert.deepEqual(visibleSkipped(rows, readDismissed(storage)).map((r) => r.id), ['e3']);
  assert.deepEqual(readDismissed({ getItem: () => 'not json' }), []);
});
test('copy address: clipboard → copied; no clipboard → select + execCommand; nothing works → manual', async () => {
  let wrote; assert.equal(await copyText('x', { nav: { clipboard: { writeText: async (t) => { wrote = t; } } } }), 'copied'); assert.equal(wrote, 'x');
  const sel = { removeAllRanges() {}, addRange() {} };
  const doc = (ok) => ({ getSelection: () => sel, createRange: () => ({ selectNodeContents() {} }), execCommand: () => ok });
  assert.equal(await copyText('x', { nav: {}, doc: doc(true), node: {} }), 'copied');
  assert.equal(await copyText('x', { nav: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc: doc(false), node: {} }), 'manual');
  assert.equal(await copyText('x', { nav: undefined, doc: undefined }), 'manual');
});
test('wiring: Documents dismiss + not-rate-con label + FAB padding; banner excludes not_ratecon; dispatch Save bar clears the FAB', () => {
  const docs = readFileSync('app/documents/page.js', 'utf8');
  assert.match(docs, /email-skipped-dismiss/); assert.match(docs, /not-ratecon-label/); assert.match(docs, /var\(--fab-space\)/);
  assert.match(readFileSync('app/components/EmailDraftsBanner.js', 'utf8'), /extraction_error\.neq\.not_ratecon/);
  assert.match(readFileSync('app/dispatch/[id]/page.js', 'utf8'), /bottom: 'calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\) \+ var\(--fab-space\)\)'/);
  assert.match(readFileSync('app/components/RateconEmailCard.js', 'utf8'), /copyText\(addr/);
});

test('webhook tags new rate con emails with the receiving company (company_id = company_profiles.id)', async () => {
  const sb = sbWith();
  sb.db.company_profiles = [{ id: '00000000-0000-4000-8000-0000000000f1', owner_id: USER }];
  await send(sb, payload());
  assert.equal(sb.db.inbound_emails[0].owner_id, USER);
  assert.equal(sb.db.inbound_emails[0].company_id, '00000000-0000-4000-8000-0000000000f1');
  const sb2 = sbWith(); // no profile yet: still saved, untagged
  await send(sb2, payload());
  assert.equal(sb2.db.inbound_emails[0].company_id, null);
});
