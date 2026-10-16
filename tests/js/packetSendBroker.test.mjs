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
  assert.deepEqual(validateSend({ ...OK, cc: 'dispatch@fstrucks.com' }, {}).cc, []);
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

function fakeSb({ packet, sendsTable = true }) {
  const tbl = { packets: [packet], packet_sends: [], company_profiles: [{ owner_id: 'owner1', legal_name: 'Test Trucking (FAKE)' }] };
  const from = (name) => {
    const st = { op: 'select', f: [] };
    const run = () => {
      if (name === 'packet_sends' && !sendsTable) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
      if (st.op === 'insert') { tbl[name].push({ id: 's' + tbl[name].length, ...st.payload }); return { error: null }; }
      const rows = tbl[name].filter((r) => st.f.every(([k, v]) => r[k] === v));
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { error: null }; }
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, order() { return b; }, limit() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve(run()).then(res, rej) };
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
  assert.equal(log.sent_by, 'u-management'); assert.deepEqual(log.to_emails, ['dispatch@fstrucks.com']); assert.deepEqual(log.cc_emails, ['ops@fstrucks.com']); assert.equal(log.postmark_message_id, 'pm-123'); assert.ok(log.sent_at);
  assert.equal(sb.tbl.packets[0].status, 'sent'); assert.equal(j.sends.length, 1);
  const g = await (await GET(req(null, 'GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver'), env: ENV } })).json();
  assert.equal(g.canSend, false); assert.equal(g.sends.length, 1); assert.deepEqual(g.allowedDomains, ['fstrucks.com']); assert.match(g.draft.subject, /Test Trucking \(FAKE\)/);
});
