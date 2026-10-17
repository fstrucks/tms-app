import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmails, allowedDomains, validateSend, senderConfig, defaultDraft, postmarkSend, canSend } from '../../app/lib/packetSend.js';
import { GET, POST } from '../../app/api/packets/[id]/send/route.js';

const PID = '00000000-0000-4000-8000-0000000000f6';
const ENV = { POSTMARK_SERVER_TOKEN: 'fake-token-for-tests' };
const OK = { to: 'dispatch@fstrucks.com', cc: '', subject: 'Packet (FAKE)', body: 'Hi (FAKE)', confirm: true };

test('parseEmails / roles / sender defaults', () => {
  assert.deepEqual(parseEmails('A@fstrucks.com, b@fstrucks.com; a@fstrucks.com').list, ['a@fstrucks.com', 'b@fstrucks.com']);
  assert.match(parseEmails('nope').error, /valid/); assert.match(parseEmails('', { required: true }).error, /Enter/);
  assert.equal(canSend('owner'), true); assert.equal(canSend('management'), true); assert.equal(canSend('dispatcher'), false); assert.equal(canSend('driver'), false);
  const c = senderConfig({}); assert.equal(c.from, 'noreply@fstrucks.com'); assert.equal(c.replyTo, 'marc@fstrucks.com'); assert.equal(c.token, null);
  assert.equal(senderConfig({ PACKET_FROM_EMAIL: 'x@fstrucks.com', PACKET_REPLY_TO: 'y@fstrucks.com' }).replyTo, 'y@fstrucks.com');
  assert.match(defaultDraft({ subject: 'Fwd: Setup packet' }, 'Test Co (FAKE)').body, /Test Co \(FAKE\).*Setup packet/s);
});

test('guardrail: default fstrucks.com only; configurable; * disables', () => {
  assert.deepEqual(allowedDomains({}), ['fstrucks.com']);
  assert.deepEqual(allowedDomains({ PACKET_SEND_ALLOWED_DOMAINS: 'fstrucks.com, example.test' }), ['fstrucks.com', 'example.test']);
  assert.equal(allowedDomains({ PACKET_SEND_ALLOWED_DOMAINS: '*' }), null);
  const r = validateSend({ ...OK, to: 'broker@outside.example', cc: 'x@fstrucks.com' }, {});
  assert.equal(r.status, 403); assert.deepEqual(r.blocked, ['broker@outside.example']);
  assert.equal(validateSend({ ...OK, cc: 'cc@other.example' }, {}).status, 403);
  assert.equal(validateSend({ ...OK, confirm: undefined }, {}).status, 400);
  assert.equal(validateSend({ ...OK, subject: 'a\r\nBcc: x' }, {}).subject, 'a Bcc: x');
  assert.deepEqual(validateSend({ ...OK, cc: 'dispatch@fstrucks.com' }, {}).cc, ['marc@fstrucks.com']); // typed CC = To dropped; the automatic copy (PACKET_CC_EMAIL default) stays
  assert.deepEqual(validateSend({ ...OK, cc: 'dispatch@fstrucks.com' }, { PACKET_CC_EMAIL: 'none' }).cc, []);
});

test('postmarkSend: payload shape (mock fetch), error 412 explained', async () => {
  let seen;
  const f = async (url, o) => { seen = { url, o, b: JSON.parse(o.body) }; return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'mock-1' }), { status: 200 }); };
  const r = await postmarkSend({ token: 't', from: 'noreply@fstrucks.com', replyTo: 'marc@fstrucks.com', stream: 'outbound', to: ['a@fstrucks.com'], cc: ['c@fstrucks.com'], subject: 'S', body: 'B', pdf: Buffer.from('%PDF-1.4 fake'), filename: 'p-filled.pdf' }, f);
  assert.equal(r.messageId, 'mock-1'); assert.equal(seen.url, 'https://api.postmarkapp.com/email');
  assert.equal(seen.o.headers['X-Postmark-Server-Token'], 't');
  assert.equal(seen.b.From, 'noreply@fstrucks.com'); assert.equal(seen.b.ReplyTo, 'marc@fstrucks.com'); assert.equal(seen.b.Cc, 'c@fstrucks.com');
  assert.equal(seen.b.Attachments[0].ContentType, 'application/pdf'); assert.equal(Buffer.from(seen.b.Attachments[0].Content, 'base64').toString(), '%PDF-1.4 fake');
  const bad = await postmarkSend({ token: 't', from: 'f', to: ['a@x.y'], cc: [], subject: 's', body: 'b', pdf: Buffer.alloc(1), filename: 'f' }, async () => new Response(JSON.stringify({ ErrorCode: 412, Message: 'pending approval' }), { status: 422 }));
  assert.match(bad.error, /test mode/); assert.equal(bad.code, 412);
});

function fakeSb({ packet, sendsTable = true, failUpdate = null, throwUpdate = null }) {
  const tbl = { packets: [packet], packet_sends: [], coi_requests: [], company_profiles: [{ owner_id: 'owner1', legal_name: 'Test Trucking (FAKE)' }] };
  const from = (name) => {
    const st = { op: 'select', f: [] };
    const run = () => {
      if (name === 'packet_sends' && !sendsTable) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
      if (st.op === 'insert') {
        if (st.payload.id && tbl[name].some((r) => r.id === st.payload.id)) return { error: { code: '23505', message: 'duplicate key' } };
        tbl[name].push({ id: 's' + tbl[name].length, sent_at: new Date().toISOString(), ...st.payload }); return { error: null };
      }
      const rows = tbl[name].filter((r) => st.f.every(([k, v]) => r[k] === v) && (!st.g || String(r[st.g[0]]) >= st.g[1]));
      if (st.op === 'update') {
        if (throwUpdate === name) throw new Error('boom (FAKE)');
        if (failUpdate === name) return { error: { code: 'XX000', message: 'fake failure' } };
        rows.forEach((r) => Object.assign(r, st.payload)); return { error: null };
      }
      if (st.op === 'delete') { tbl[name] = tbl[name].filter((r) => !rows.includes(r)); return { error: null }; }
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, gte(k, v) { st.g = [k, v]; return b; }, order() { return b; }, limit() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) };
    return b;
  };
  const storage = { from: () => ({ download: async (p) => (p === 'owner1/packets/filled/x.pdf' ? { data: new Blob([Buffer.from('%PDF fake')]) } : { data: null }) }) };
  return { from, storage, tbl };
}
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async () => ({ data: role }) });
const req = (body, method = 'POST') => new Request(`http://x/api/packets/${PID}/send`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const pkt = (o = {}) => ({ id: PID, owner_id: 'owner1', status: 'review', original_filename: 'Broker Packet (FAKE).pdf', filled_path: 'owner1/packets/filled/x.pdf', ...o });
const mockFetch = () => { const calls = []; const f = async (u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-123' }), { status: 200 }); }; f.calls = calls; return f; };

test('send route: role, confirm, guardrail, not-filled, no token, missing table all refuse WITHOUT calling Postmark', async () => {
  const f = mockFetch();
  const run = async (role, body, o = {}) => (await POST(req(body), { params: { id: PID }, deps: { sb: o.sb || fakeSb({ packet: pkt(o.p) }), mkUserClient: uc(role), env: o.env || ENV, fetch: f } })).status;
  assert.equal(await run('dispatcher', OK), 403);
  assert.equal(await run('driver', OK), 403);
  assert.equal(await run('owner', { ...OK, confirm: false }), 400);
  assert.equal(await run('owner', { ...OK, to: 'broker@outside.example' }), 403);
  assert.equal(await run('owner', OK, { p: { filled_path: null } }), 409);
  assert.equal(await run('owner', OK, { env: {} }), 503);
  assert.equal(await run('owner', OK, { sb: fakeSb({ packet: pkt(), sendsTable: false }) }), 503);
  assert.equal(f.calls.length, 0);
});

test('send route: management sends via (mock) Postmark, logs who/when/to/message id, marks Sent', async () => {
  const sb = fakeSb({ packet: pkt() }); const f = mockFetch();
  const r = await POST(req({ ...OK, cc: 'ops@fstrucks.com' }), { params: { id: PID }, deps: { sb, mkUserClient: uc('management'), env: ENV, fetch: f } });
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.messageId, 'pm-123'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ReplyTo, 'marc@fstrucks.com');
  const log = sb.tbl.packet_sends[0];
  assert.equal(log.sent_by, 'u-management'); assert.deepEqual(log.to_emails, ['dispatch@fstrucks.com']); assert.deepEqual(log.cc_emails, ['ops@fstrucks.com', 'marc@fstrucks.com']); assert.equal(f.calls[0].Cc, 'ops@fstrucks.com, marc@fstrucks.com'); assert.equal(log.postmark_message_id, 'pm-123'); assert.ok(log.sent_at);
  assert.equal(sb.tbl.packets[0].status, 'sent'); assert.equal(j.sends.length, 1);
  const g = await (await GET(req(null, 'GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver'), env: ENV } })).json();
  assert.equal(g.canSend, false); assert.equal(g.sends.length, 1); assert.deepEqual(g.allowedDomains, ['fstrucks.com']); assert.match(g.draft.subject, /Test Trucking \(FAKE\)/);
});

// ---- QA #64 round 1 fixes ----
import { attemptOutcome, newSendKey } from '../../app/lib/packetSendClient.js';
import { formatSentAt, parseUtc } from '../../app/lib/packetDate.js';
import { readFileSync } from 'node:fs';
const K1 = '11111111-1111-4111-8111-111111111111', K2 = '22222222-2222-4222-8222-222222222222';
const post = (sb, body, o = {}) => POST(req(body), { params: { id: PID }, deps: { sb, mkUserClient: uc(o.role || 'owner'), env: o.env || ENV, fetch: o.fetch || mockFetch() } });

test('idempotency: same key twice → Postmark called once, second call returns the earlier result', async () => {
  const sb = fakeSb({ packet: pkt() }); const f = mockFetch();
  const r1 = await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f }); assert.equal(r1.status, 200);
  const r2 = await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f }); assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.equal(j2.duplicate, true); assert.equal(j2.messageId, 'pm-123'); assert.equal(j2.id, K1);
  assert.equal(f.calls.length, 1); assert.equal(sb.tbl.packet_sends.length, 1); assert.equal(sb.tbl.packet_sends[0].id, K1);
  assert.equal(j2.sends.length, 1); assert.equal(j2.sends[0].confirmed, true);
});

test('idempotency: concurrent double-press with the same key sends once', async () => {
  const sb = fakeSb({ packet: pkt() }); const f = mockFetch();
  const [a, b] = await Promise.all([post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f }), post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f })]);
  assert.equal(f.calls.length, 1);
  assert.ok([a.status, b.status].includes(200)); for (const x of [a, b]) assert.ok([200, 409].includes(x.status), String(x.status));
  assert.equal(sb.tbl.packet_sends.length, 1);
});

test('already sent: a NEW key needs resend:true ("Send again?"), then sends', async () => {
  const sb = fakeSb({ packet: pkt() }); const f = mockFetch();
  await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f });
  const r = await post(sb, { ...OK, idempotencyKey: K2 }, { fetch: f });
  assert.equal(r.status, 409); const j = await r.json();
  assert.equal(j.alreadySent, true); assert.equal(j.last.id, K1); assert.ok(j.last.sent_at); assert.equal(f.calls.length, 1);
  const r2 = await post(sb, { ...OK, idempotencyKey: K2, resend: true }, { fetch: f });
  assert.equal(r2.status, 200); assert.equal(f.calls.length, 2); assert.equal((await r2.json()).sends.length, 2);
});

test('bad idempotency key refused before Postmark', async () => {
  const f = mockFetch();
  assert.equal((await post(fakeSb({ packet: pkt() }), { ...OK, idempotencyKey: 'not-a-uuid' }, { fetch: f })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('email sent but send-log update fails or throws → still 200 with a warning (never "error" after a real send)', async () => {
  for (const o of [{ failUpdate: 'packet_sends' }, { throwUpdate: 'packet_sends' }, { failUpdate: 'packets' }]) {
    const sb = fakeSb({ packet: pkt(), ...o }); const f = mockFetch();
    const r = await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f });
    assert.equal(r.status, 200, JSON.stringify(o)); const j = await r.json();
    assert.equal(j.ok, true); assert.equal(f.calls.length, 1);
    if (o.failUpdate === 'packets') assert.equal(j.warning, undefined); else { assert.equal(j.logged, false); assert.match(j.warning, /was sent/); }
  }
});

test('Postmark refuses → claim released (no phantom history row), same key can retry', async () => {
  const sb = fakeSb({ packet: pkt() });
  const refuse = async () => new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }), { status: 422 });
  const r = await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: refuse });
  assert.equal(r.status, 502); assert.equal(sb.tbl.packet_sends.length, 0);
  const f = mockFetch(); assert.equal((await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f })).status, 200); assert.equal(f.calls.length, 1);
});

test('Postmark connection drop / timeout → 504 unknown, claim kept as "not confirmed", repeat never resends', async () => {
  const sb = fakeSb({ packet: pkt() });
  const drop = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET' }; throw e; };
  const r = await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: drop });
  assert.equal(r.status, 504); assert.equal((await r.json()).unknown, true);
  assert.equal(sb.tbl.packet_sends.length, 1); assert.equal(sb.tbl.packet_sends[0].postmark_message_id, null);
  const f = mockFetch(); const r2 = await post(sb, { ...OK, idempotencyKey: K1 }, { fetch: f });
  assert.equal(r2.status, 409); assert.equal((await r2.json()).pending, true); assert.equal(f.calls.length, 0);
  const g = await (await GET(req(null, 'GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env: ENV } })).json();
  assert.equal(g.sends[0].confirmed, false);
  // a sure connect failure is "nothing was sent" and releases the claim
  const sb2 = fakeSb({ packet: pkt() });
  const refused = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  assert.equal((await post(sb2, { ...OK, idempotencyKey: K1 }, { fetch: refused })).status, 502); assert.equal(sb2.tbl.packet_sends.length, 0);
});

test('postmarkSend times out with AbortSignal (unknown result)', async () => {
  // (AbortSignal.timeout's timer is unref'd, so keep the loop alive while we wait for it.)
  const keep = setInterval(() => {}, 5); let sig;
  const hang = (u, o) => { sig = o.signal; return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))); };
  const r = await postmarkSend({ token: 't', from: 'f', to: ['a@fstrucks.com'], cc: [], subject: 's', body: 'b', pdf: Buffer.alloc(1), filename: 'f', timeoutMs: 20 }, hang).finally(() => clearInterval(keep));
  assert.ok(sig instanceof AbortSignal);
  assert.equal(r.unknown, true); assert.match(r.error, /can’t tell/);
});

test('route maxDuration is set and covers the Postmark timeout', async () => {
  const m = await import('../../app/api/packets/[id]/send/route.js');
  const { POSTMARK_TIMEOUT_MS } = await import('../../app/lib/packetSend.js');
  assert.ok(m.maxDuration >= POSTMARK_TIMEOUT_MS / 1000 + 5 && m.maxDuration <= 60, String(m.maxDuration));
});

test('server enforces PACKET_SEND_ALLOWED_DOMAINS on To and CC (default fstrucks.com), before Postmark', async () => {
  const f = mockFetch();
  const st = async (body, env = ENV) => (await post(fakeSb({ packet: pkt() }), body, { fetch: f, env })).status;
  assert.equal(await st({ ...OK, to: 'broker@outside.example' }), 403);
  assert.equal(await st({ ...OK, cc: 'boss@outside.example' }), 403);
  assert.equal(await st({ ...OK, to: 'a@fstrucks.com, b@outside.example' }), 403);
  assert.equal(await st({ ...OK, to: ['a@fstrucks.com', 'b@FSTRUCKS.com.evil.example'] }), 403);
  assert.equal(await st({ ...OK, to: 'a@sub.fstrucks.com' }), 403);
  assert.equal(await st({ ...OK, cc: 'x@outside.example' }, { ...ENV, PACKET_SEND_ALLOWED_DOMAINS: '' }), 403);
  assert.equal(await st({ ...OK, cc: 'x@outside.example' }, { ...ENV, PACKET_SEND_ALLOWED_DOMAINS: 'fstrucks.com' }), 403);
  assert.equal(f.calls.length, 0);
  const r = await post(fakeSb({ packet: pkt() }), { ...OK, to: 'b@partner.example' }, { fetch: f, env: { ...ENV, PACKET_SEND_ALLOWED_DOMAINS: 'fstrucks.com,partner.example' } });
  assert.equal(r.status, 200); assert.equal(f.calls.length, 1);
});

test('attemptOutcome: history check after a network error', () => {
  assert.equal(attemptOutcome([{ id: K1, confirmed: true }], K1), 'sent');
  assert.equal(attemptOutcome([{ id: K1, postmark_message_id: null, confirmed: false }], K1), 'unknown');
  assert.equal(attemptOutcome([{ id: K2, confirmed: true }], K1), 'not-sent');
  assert.equal(attemptOutcome(undefined, K1), 'not-sent');
  assert.match(newSendKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('send times: shown in the viewer’s zone with a zone label; zoneless timestamps read as UTC', () => {
  // 6:34 AM PT send = 13:34 UTC. Taylor's QA browser (box) runs Central time, which is why it read 8:34.
  assert.equal(formatSentAt('2026-10-17T13:34:00+00:00', 'America/Los_Angeles'), '10/17/2026, 6:34 AM PDT');
  assert.equal(formatSentAt('2026-10-17T13:34:00.123Z', 'America/Chicago'), '10/17/2026, 8:34 AM CDT');
  assert.equal(formatSentAt('2026-10-17 13:34:00', 'America/Los_Angeles'), '10/17/2026, 6:34 AM PDT');
  assert.equal(parseUtc('2026-10-17T13:34:00').toISOString(), '2026-10-17T13:34:00.000Z');
  assert.match(formatSentAt('2026-10-17T13:34:00Z'), /\d{1,2}:\d{2} [AP]M [A-Z]{2,5}|GMT/); // test TZ = LA → PDT
  assert.equal(formatSentAt('nope'), '');
  const src = readFileSync(new URL('../../app/packets/PacketSendBroker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /toLocaleTimeString/); assert.match(src, /formatSentAt\(s\.sent_at\)/);
});

test('send writes sent_at as a UTC ISO instant (timestamptz-safe)', async () => {
  const sb = fakeSb({ packet: pkt() });
  await post(sb, { ...OK, idempotencyKey: K1 });
  assert.match(sb.tbl.packet_sends[0].sent_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(sb.tbl.packets[0].sent_at, /Z$/);
});

test('iPhone: Fill & download bar hidden during send write/review (unless unsaved edits); client sends idempotency key + resend', () => {
  const m = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
  assert.match(m, /actionBarShown\(\{ canEdit, hideActionBar, dirty \}\)/); assert.match(m, /\{barShown && <div ref=\{bar\}/);
  const p = readFileSync(new URL('../../app/packets/[id]/page.js', import.meta.url), 'utf8');
  assert.match(p, /hideActionBar=\{sendStep === 'write' \|\| sendStep === 'review'( \|\| coiStep === 'write' \|\| coiStep === 'review')?\}/); assert.match(p, /onStepChange=\{setSendStep\}/);
  const c = readFileSync(new URL('../../app/packets/PacketSendBroker.js', import.meta.url), 'utf8');
  assert.match(c, /idempotencyKey: k/); assert.match(c, /resend: true/); assert.match(c, /already sent on/); assert.match(c, /attemptOutcome\(h\.sends, k\)/);
});
