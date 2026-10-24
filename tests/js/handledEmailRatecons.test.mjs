// Load delete must not send emailed rate cons back to Docs > Needs attention.
// Fake rows only. The writer in production is the security-definer function; this file
// checks the same predicate, the delete order, and that handled rows stay out of the inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { emailRateconHandledOnLoadDelete } from '../../app/lib/handledRatecons.js';
import { deleteLoad } from '../../app/lib/loadDelete.js';
import { isEmailDraft, emailDraftState } from '../../app/lib/rateconDrafts.js';
import { needsAttention, fetchNeedsAttention, selectNeedsAttention } from '../../app/lib/docsInbox.js';
import { selectInboxTeamDocs } from '../../app/lib/docsInboxQuery.js';
import { pageLoadVault } from '../../app/lib/loadVault.js';
import { vaultTileCounts } from '../../app/lib/vaultCounts.js';
import { countRateconsWaiting } from '../../app/lib/homeCurrentLoad.js';
import { linkDocumentToExistingLoad } from '../../app/lib/rateconMatch.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MIG = '../../supabase/migrations/20261024000500_handled_email_ratecons.sql';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const DISP = '00000000-0000-4000-8000-0000000000a5';
const OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const L2 = '00000000-0000-4000-8000-0000000000b2';
const scope = { loadId: L1, ownerId: OWNER, companyUserIds: [OWNER, DISP] };

const doc = (id, extra) => ({
  id, user_id: OWNER, load_id: L1, source: 'email', doc_type: 'rate_confirmation',
  file_path: `${OWNER}/${id}.pdf`, original_filename: `${id}.pdf`, created_at: '2026-10-24T00:00:00Z',
  handled_at: null, ...extra,
});

test('mark only email rate cons for that load, same company: not BOLs, not other loads, not other companies', () => {
  const rows = [
    doc('rc'),
    doc('rc-disp', { user_id: DISP }),
    doc('bol', { doc_type: 'bol' }),
    doc('upload-rc', { source: 'upload' }),
    doc('other-load', { load_id: L2 }),
    doc('other-co', { user_id: OTHER }),
    doc('unset-type', { doc_type: null }),
    doc('already', { handled_at: '2026-10-01T00:00:00Z' }),
  ];
  assert.deepEqual(rows.filter((d) => emailRateconHandledOnLoadDelete(d, scope)).map((d) => d.id), ['rc', 'rc-disp']);
  assert.equal(emailRateconHandledOnLoadDelete(doc('rc'), { loadId: L1, ownerId: OWNER, companyUserIds: [] }), true);
  assert.equal(rows.filter((d) => emailRateconHandledOnLoadDelete(d, { loadId: L1, ownerId: OWNER, companyUserIds: [OWNER] })).some((d) => d.id === 'rc-disp'), false);
});

test('a handled email rate con is not a draft and not Needs attention', () => {
  const handled = doc('rc', { load_id: null, handled_at: '2026-10-24T12:00:00Z' });
  const draft = doc('open', { load_id: null, handled_at: null });
  assert.equal(isEmailDraft(draft), true);
  assert.equal(isEmailDraft(handled), false);
  assert.equal(emailDraftState(handled), null);
  assert.equal(emailDraftState(draft), 'manual');
  assert.equal(needsAttention(handled), false);
  assert.equal(needsAttention(draft), true);
  assert.deepEqual(selectNeedsAttention([handled, draft]).map((d) => d.id), ['open']);
});

test('Needs attention fetch, team inbox, home count, and tile count skip the handled marker', async () => {
  const handled = doc('handled', { load_id: null, handled_at: '2026-10-24T12:00:00Z', truck_id: null });
  const draft = doc('draft', { load_id: null, handled_at: null, truck_id: null });
  const bol = doc('bol', { load_id: null, source: 'upload', doc_type: 'bol', handled_at: null, truck_id: null, user_id: DISP });
  const stamped = doc('stamped', { load_id: null, source: 'upload', doc_type: 'bol', handled_at: '2026-10-24T12:00:00Z', truck_id: null, user_id: DISP });
  const tables = {
    documents: [handled, draft, bol, stamped],
    scale_tickets: [],
    company_members: [{ user_id: DISP, 'company_profiles.owner_id': OWNER }],
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    loads: [],
    drivers: [],
  };
  const mine = await fetchNeedsAttention(fakeSupabase({ tables }));
  assert.deepEqual(mine.documents.map((d) => d.id), ['draft', 'bol']);
  const team = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: OWNER });
  assert.deepEqual(team.documents.map((d) => d.id), ['bol']);
  for (const file of ['../../app/lib/docsInbox.js', '../../app/lib/docsInboxQuery.js', '../../app/lib/vaultCounts.js', '../../app/lib/homeCurrentLoad.js', '../../app/components/EmailDraftsBanner.js', '../../app/lib/loadVaultQuery.js']) {
    assert.match(read(file), /handled_at/, file);
  }
  const counts = await vaultTileCounts(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: OWNER, profileId: 'p1' });
  assert.equal(counts.loadDocs, 1);
  const waiting = await countRateconsWaiting(countClient([
    { source: 'email', load_id: null, doc_type: 'rate_confirmation', extraction_error: null, handled_at: null },
    { source: 'email', load_id: null, doc_type: 'rate_confirmation', extraction_error: null, handled_at: '2026-10-24T12:00:00Z' },
    { source: 'email', load_id: null, doc_type: 'rate_confirmation', extraction_error: 'not_ratecon', handled_at: null },
    { source: 'email', load_id: L1, doc_type: 'rate_confirmation', extraction_error: null, handled_at: null },
  ]));
  assert.equal(waiting, 1);
});

test('the load vault still lists a handled rate con and does not treat it as Needs attention', () => {
  const handled = doc('kept', { load_id: null, handled_at: '2026-10-24T12:00:00Z' });
  const draft = doc('draft', { load_id: null, handled_at: null });
  const page = pageLoadVault({
    docs: [handled, draft],
    loads: [],
    role: 'owner',
    userId: OWNER,
    ownerId: OWNER,
    limit: 20,
  });
  assert.deepEqual(page.rows.map((r) => r.doc.id), ['kept']);
  assert.equal(needsAttention(page.rows[0].doc), false);
});

test('deleteLoad marks email rate cons before unlinking, and a load with no matches is a no-op mark', async () => {
  const rows = [
    doc('rc'),
    doc('bol', { doc_type: 'bol', source: 'upload' }),
    doc('other-load', { load_id: L2 }),
    doc('other-co', { user_id: OTHER }),
  ];
  const { sb, calls } = client(rows);
  const r = await deleteLoad(sb, L1, { docs: rows.filter((d) => d.load_id === L1) });
  assert.equal(r.ok, true);
  const order = calls.map((c) => c[0] === 'rpc' ? `rpc:${c[1]}` : `${c[0]}:${c[1]}`);
  const rpcAt = order.indexOf('rpc:mark_load_email_ratecons_handled');
  const unlinkAt = order.findIndex((x) => x === 'update:documents');
  const loadAt = order.indexOf('delete:loads');
  assert.ok(rpcAt >= 0 && rpcAt < unlinkAt && unlinkAt < loadAt);
  assert.equal(calls.find((c) => c[0] === 'rpc')[2].p_load, L1);
  assert.equal(rows.find((d) => d.id === 'rc').handled_at != null, true);
  assert.equal(rows.find((d) => d.id === 'rc').load_id, null);
  assert.equal(rows.find((d) => d.id === 'bol').handled_at, null);
  assert.equal(rows.find((d) => d.id === 'other-load').handled_at, null);
  assert.equal(rows.find((d) => d.id === 'other-load').load_id, L2);
  assert.equal(rows.find((d) => d.id === 'other-co').handled_at, null);
  assert.equal(needsAttention({ ...rows.find((d) => d.id === 'rc') }), false);
  assert.ok(!calls.some((c) => c[0] === 'update' && c[1] === 'loads'));
  assert.ok(!calls.some((c) => c[0] === 'delete' && c[1] === 'documents'));

  const quiet = [doc('bol-only', { doc_type: 'bol', source: 'upload', load_id: L1 })];
  const second = client(quiet);
  const again = await deleteLoad(second.sb, L1, { docs: quiet });
  assert.equal(again.ok, true);
  assert.equal(second.calls.filter((c) => c[0] === 'rpc').length, 1);
  assert.equal(quiet[0].handled_at, null);
  assert.equal(second.sb.marked, 0);
});

test('a failed mark stops the delete before documents or the load change', async () => {
  const rows = [doc('rc')];
  const { sb, calls } = client(rows, { rpcError: { message: 'not_permitted' } });
  const r = await deleteLoad(sb, L1, { docs: rows });
  assert.equal(r.ok, false);
  assert.match(r.error, /not_permitted/);
  assert.equal(rows[0].handled_at, null);
  assert.equal(rows[0].load_id, L1);
  assert.ok(!calls.some((c) => c[0] === 'update' && c[1] === 'documents'));
  assert.ok(!calls.some((c) => c[0] === 'delete' && c[1] === 'loads'));
});

test('migration adds handled_at and a definer function, with no new document or storage policies', () => {
  const sql = read(MIG);
  assert.match(sql, /add column if not exists handled_at timestamptz/);
  assert.match(sql, /create or replace function public\.mark_load_email_ratecons_handled\(p_load uuid\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public/);
  assert.match(sql, /revoke all on function public\.mark_load_email_ratecons_handled\(uuid\) from public/);
  assert.match(sql, /grant execute on function public\.mark_load_email_ratecons_handled\(uuid\) to authenticated/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /packet_role\(v_owner\) in \('owner', 'management', 'dispatcher'\)/);
  const upd = sql.slice(sql.toLowerCase().indexOf('update public.documents'), sql.toLowerCase().indexOf('get diagnostics'));
  assert.match(upd, /handled_at = now\(\)/);
  assert.match(upd, /load_id = p_load/);
  assert.match(upd, /source = 'email'/);
  assert.match(upd, /doc_type = 'rate_confirmation'/);
  assert.match(upd, /handled_at is null/);
  assert.match(upd, /user_id = v_owner/);
  assert.match(upd, /company_members/);
  const body = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /create policy/i);
  assert.doesNotMatch(body, /storage\.objects/i);
  assert.doesNotMatch(body, /update\s+public\.loads/i);
  assert.doesNotMatch(body, /delete\s+from/i);
  assert.doesNotMatch(body, /grant\s+update\s+\([^)]*handled_at/i);
  assert.match(sql, /revoke insert \(handled_at\), update \(handled_at\) on public\.documents from authenticated/);
});

test('auto-link and Link to existing load still write load_id only', async () => {
  const email = read('../../app/lib/rateconEmail.js');
  const linkFn = email.slice(email.indexOf('async function linkParsedRatecon'), email.indexOf('export async function extractEmailRateCon'));
  assert.match(linkFn, /update\(\{ load_id: match\.id \}\)/);
  assert.doesNotMatch(linkFn, /handled_at/);
  let body;
  const fetchImpl = async (_url, init) => {
    body = init.body;
    return { ok: true, json: async () => ({ document: { load_id: L1 } }) };
  };
  const linked = await linkDocumentToExistingLoad(fetchImpl, { docId: 'd1', loadId: L1, token: 't' });
  assert.equal(linked.ok, true);
  assert.equal(body, JSON.stringify({ loadId: L1 }));
  assert.doesNotMatch(read('../../app/lib/rateconMatch.js'), /handled_at/);
});

function countClient(rows) {
  return {
    from() {
      const filters = [];
      const api = {
        select() { return api; },
        eq(c, v) { filters.push((r) => r[c] === v); return api; },
        is(c, v) { filters.push((r) => (v == null ? r[c] == null : r[c] === v)); return api; },
        or(expr) {
          if (String(expr).includes('not_ratecon')) filters.push((r) => r.extraction_error == null || r.extraction_error !== 'not_ratecon');
          const count = rows.filter((r) => filters.every((f) => f(r))).length;
          return Promise.resolve({ count, error: null });
        },
      };
      return api;
    },
  };
}

function client(rows, { rpcError = null } = {}) {
  const calls = [];
  const sb = {
    marked: 0,
    from(t) {
      return {
        select() { return { eq: async () => ({ data: t === 'invoices' ? [] : [], error: null }) }; },
        update(patch) {
          return { eq: async (_c, v) => {
            calls.push(['update', t, patch, v]);
            if (t === 'documents' && patch && Object.prototype.hasOwnProperty.call(patch, 'load_id')) {
              for (const d of rows) if (d.load_id === v || d.id === v) if (patch.load_id === null) d.load_id = null;
            }
            return { error: null };
          } };
        },
        delete() {
          return { eq(_c, v) {
            const p = { select: async () => { calls.push(['delete', t, v]); return { data: [{ id: v }], error: null }; } };
            p.then = (ok, ko) => { calls.push(['delete', t, v]); return Promise.resolve({ error: null }).then(ok, ko); };
            return p;
          } };
        },
      };
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    rpc: async (fn, args) => {
      calls.push(['rpc', fn, args]);
      if (rpcError) return { data: null, error: rpcError };
      let n = 0;
      for (const d of rows) {
        if (!emailRateconHandledOnLoadDelete(d, scope) || d.load_id !== args?.p_load) continue;
        d.handled_at = '2026-10-24T12:00:00Z';
        n += 1;
      }
      sb.marked = n;
      return { data: n, error: null };
    },
  };
  return { sb, calls };
}
