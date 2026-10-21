// Invoicing PR 1: billing settings, brokers, factoring companies, logo. Fake data only (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { canViewInvoices, canEditInvoices, validateBroker, validateFactor, validateBillingSettings, parseTerms, parseEmails, termsLabel, publicBilling, checkLogo, dbErrorText } from '../../app/lib/invoice.js';
import * as BILLING from '../../app/api/billing/route.js';
import * as BROKERS from '../../app/api/billing/brokers/route.js';
import * as BROKER from '../../app/api/billing/brokers/[id]/route.js';
import * as FACTORS from '../../app/api/billing/factors/route.js';
import * as LOGO from '../../app/api/billing/logo/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', MGMT = '00000000-0000-4000-8000-0000000000a4', DISP = '00000000-0000-4000-8000-0000000000a5', DRIVER = '00000000-0000-4000-8000-0000000000a2';
const B1 = '00000000-0000-4000-8000-0000000000d1', F1 = '00000000-0000-4000-8000-0000000000e1';

test('roles: office roles read; owner + management write; drivers nothing', () => {
  for (const r of ['owner', 'management', 'dispatcher']) assert.ok(canViewInvoices(r), r);
  assert.ok(!canViewInvoices('driver') && !canViewInvoices(null));
  assert.ok(canEditInvoices('owner') && canEditInvoices('management'));
  assert.ok(!canEditInvoices('dispatcher') && !canEditInvoices('driver'));
});

test('terms, emails, labels', () => {
  assert.deepEqual(parseTerms(''), { value: null });
  assert.deepEqual(parseTerms('Net 30'), { value: 30 });
  assert.deepEqual(parseTerms(0), { value: 0 });
  assert.ok(parseTerms(121).error && parseTerms('abc').error && parseTerms('', { allowNull: false }).error);
  assert.deepEqual(parseEmails('AP@example.com, billing@example.com;ap@example.com').list, ['ap@example.com', 'billing@example.com']);
  assert.ok(parseEmails('not-an-email').error);
  assert.equal(termsLabel(30), 'Net 30');
  assert.equal(termsLabel(0), 'Due on receipt');
});

test('validateBroker / validateFactor / settings', () => {
  assert.ok(validateBroker({}).error);
  const b = validateBroker({ name: ' Acme Freight Brokerage (fake) ', billing_emails: 'ap@example.com', terms_days: '15', mc_number: 'MC-000000', noa_on_file: true });
  assert.deepEqual(b.row, { name: 'Acme Freight Brokerage (fake)', mc_number: 'MC-000000', address: null, billing_emails: ['ap@example.com'], terms_days: 15, quick_pay_terms: null, noa_on_file: true, notes: null });
  assert.ok(validateBroker({ name: 'x', mc_number: 'abc' }).error);
  assert.ok(validateFactor({ name: 'Sample Factor Co', portal_url: 'http://x' }).error);
  assert.ok(validateFactor({ name: 'Sample Factor Co', packet_format: 'zip' }).error);
  assert.equal(validateFactor({ name: 'Sample Factor Co', submission_email: 'Submit@Example.com' }).row.submission_email, 'submit@example.com');
  assert.equal(validateFactor({ name: 'Sample Factor Co' }).row.packet_format, 'merged');
  assert.deepEqual(validateBillingSettings({ default_terms_days: '30', default_factor_id: F1, remit_to: ' PO Box 0 ' }, [F1]).patch, { default_terms_days: 30, default_factor_id: F1, remit_to: 'PO Box 0' });
  assert.ok(validateBillingSettings({ default_factor_id: 'nope' }, [F1]).error);
  assert.ok(validateBillingSettings({ default_terms_days: '' }).error);
  assert.deepEqual(publicBilling({ logo_path: 'x', invoice_next_number: 1005 }), { invoice_prefix: 'INV-', invoice_next_number: 1005, default_terms_days: 30, default_factor_id: null, remit_to: null, has_logo: true });
  assert.ok(checkLogo({ type: 'image/gif', size: 10 }).error && checkLogo({ type: 'image/png', size: 2e6 }).error);
  assert.equal(checkLogo({ type: 'image/png', size: 1000 }).ext, 'png');
  assert.equal(dbErrorText({ message: 'not_draft' }), 'This invoice is already finalized.');
  assert.equal(dbErrorText({ code: '23505', message: 'brokers_owner_name_uniq broker' }), 'You already have a broker with that name.');
});

// ---- routes ----
function ctx(role, userId, extra = {}, missing = []) {
  const tables = {
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC', invoice_prefix: 'INV-', invoice_next_number: 1001, default_terms_days: 30, default_factor_id: null, logo_path: null }],
    brokers: [{ id: B1, owner_id: OWNER, name: 'Acme Freight Brokerage (fake)', billing_emails: ['ap@example.com'], terms_days: null }],
    factors: [{ id: F1, owner_id: OWNER, name: 'Sample Factor Co', packet_format: 'merged' }],
    ...extra,
  };
  const svc = fakeSupabase({ tables, missing });
  const uploads = [], removed = [];
  svc.storage.from = () => ({ upload: async (p) => { uploads.push(p); return { data: { path: p }, error: null }; }, remove: async (ps) => { removed.push(...ps); return { error: null }; }, createSignedUrl: async (p) => ({ data: { signedUrl: `https://fake.invalid/${p}` } }) });
  // The user-token client shares the same fake tables (RLS is covered by tests/sql/invoicing.pglite.mjs).
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }) };
  return { svc, uploads, removed, deps: { mkUserClient: () => uc, sb: svc } };
}
const req = (method, body) => new Request('http://x/api', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('GET /api/billing: office roles see settings + lists; drivers get 403', async () => {
  const j = await (await BILLING.GET(req('GET'), { deps: ctx('dispatcher', DISP).deps })).json();
  assert.equal(j.canEdit, false);
  assert.equal(j.settings.invoice_next_number, 1001);
  assert.equal(j.brokers.length, 1);
  assert.equal(j.factors.length, 1);
  assert.equal((await BILLING.GET(req('GET'), { deps: ctx('management', MGMT).deps })).status, 200);
  assert.equal((await BILLING.GET(req('GET'), { deps: ctx('driver', DRIVER).deps })).status, 403);
});

test('GET /api/billing: 409 setupNeeded before the migration', async () => {
  const c = ctx('owner', OWNER, {}, ['brokers']);
  const r = await BILLING.GET(req('GET'), { deps: c.deps });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).setupNeeded, true);
});

test('PATCH /api/billing: management sets terms + default factor; dispatcher 403; bad factor 422', async () => {
  const c = ctx('management', MGMT);
  const r = await BILLING.PATCH(req('PATCH', { default_terms_days: '45', default_factor_id: F1 }), { deps: c.deps });
  assert.equal(r.status, 200);
  assert.equal(c.svc.db.company_profiles[0].default_terms_days, 45);
  assert.equal(c.svc.db.company_profiles[0].default_factor_id, F1);
  assert.equal((await BILLING.PATCH(req('PATCH', { default_factor_id: B1 }), { deps: c.deps })).status, 422);
  assert.equal((await BILLING.PATCH(req('PATCH', { default_terms_days: 30 }), { deps: ctx('dispatcher', DISP).deps })).status, 403);
});

test('brokers: add / edit / delete (owner + management only)', async () => {
  const c = ctx('owner', OWNER);
  const r = await BROKERS.POST(req('POST', { name: 'Beta Logistics (fake)', billing_emails: 'billing@example.com', terms_days: '' }), { deps: c.deps });
  assert.equal(r.status, 201);
  const { broker } = await r.json();
  assert.equal(broker.owner_id, OWNER);
  assert.equal(broker.terms_days, null);
  assert.equal((await BROKER.PATCH(req('PATCH', { name: 'Beta Logistics (fake)', terms_days: '20' }), { params: { id: broker.id }, deps: c.deps })).status, 200);
  assert.equal(c.svc.db.brokers.find((b) => b.id === broker.id).terms_days, 20);
  assert.equal((await BROKER.DELETE(req('DELETE'), { params: { id: broker.id }, deps: c.deps })).status, 200);
  assert.equal((await BROKER.DELETE(req('DELETE'), { params: { id: broker.id }, deps: c.deps })).status, 404);
  assert.equal((await BROKERS.POST(req('POST', { name: 'x' }), { deps: ctx('dispatcher', DISP).deps })).status, 403);
  assert.equal((await BROKERS.POST(req('POST', { name: '' }), { deps: c.deps })).status, 422);
});

test('factors: add with remit-to; no factor data is seeded by the migration', async () => {
  const c = ctx('management', MGMT);
  const r = await FACTORS.POST(req('POST', { name: 'Test Factor (fake)', remit_to: 'Test Factor, PO Box 0000, Example City', packet_format: 'separate' }), { deps: c.deps });
  assert.equal(r.status, 201);
  const sql = read('../../supabase/migrations/20261021000100_invoicing.sql');
  assert.ok(!/insert\s+into\s+public\.(factors|brokers)/i.test(sql), 'no seeded factor / broker rows');
});

test('logo: PNG upload saves the path; GIF rejected; delete clears it; dispatcher cannot upload', async () => {
  const c = ctx('owner', OWNER);
  const fd = new FormData(); fd.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }));
  const r = await LOGO.POST(new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer t' }, body: fd }), { deps: c.deps });
  assert.equal(r.status, 200);
  assert.match(c.svc.db.company_profiles[0].logo_path, new RegExp(`^${OWNER}/company/logo-\\d+\\.png$`));
  const fd2 = new FormData(); fd2.append('file', new File(['GIF89a'], 'x.gif', { type: 'image/gif' }));
  assert.equal((await LOGO.POST(new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer t' }, body: fd2 }), { deps: c.deps })).status, 422);
  assert.ok((await (await LOGO.GET(req('GET'), { deps: c.deps })).json()).url.startsWith('https://fake.invalid/'));
  assert.equal((await LOGO.DELETE(req('DELETE'), { deps: c.deps })).status, 200);
  assert.equal(c.svc.db.company_profiles[0].logo_path, null);
  assert.equal(c.removed.length, 1);
  const fd3 = new FormData(); fd3.append('file', new File(['x'], 'logo.png', { type: 'image/png' }));
  assert.equal((await LOGO.POST(new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer t' }, body: fd3 }), { deps: ctx('dispatcher', DISP).deps })).status, 403);
});

test('company page shows Billing to office roles only; no outside email anywhere in invoicing PR 1', () => {
  const page = read('../../app/company/page.js');
  assert.match(page, /role !== 'driver' && <CompanyBilling \/>/);
  for (const f of ['../../app/company/CompanyBilling.js', '../../app/lib/invoiceServer.js', '../../app/api/billing/route.js']) assert.ok(!/postmark/i.test(read(f)), f);
});

test('QA #4: prefix is editable (owner / management), validated; billing nits', async () => {
  const { parsePrefix } = await import('../../app/lib/invoice.js');
  assert.deepEqual(parsePrefix(''), { value: 'INV-' });
  assert.deepEqual(parsePrefix(' FT- '), { value: 'FT-' });
  assert.ok(parsePrefix('bad prefix!').error && parsePrefix('x'.repeat(11)).error);
  const c = ctx('management', MGMT);
  assert.equal((await BILLING.PATCH(req('PATCH', { invoice_prefix: 'FT-' }), { deps: c.deps })).status, 200);
  assert.equal(c.svc.db.company_profiles[0].invoice_prefix, 'FT-');
  assert.equal((await BILLING.PATCH(req('PATCH', { invoice_prefix: 'no spaces' }), { deps: c.deps })).status, 422);
  assert.equal((await BILLING.PATCH(req('PATCH', { invoice_prefix: 'X-' }), { deps: ctx('dispatcher', DISP).deps })).status, 403);
  const ui = read('../../app/company/CompanyBilling.js');
  assert.match(ui, /data-testid="billing-saved"/);
  assert.match(ui, /st\.settings\.has_logo \|\| logoLoading \? <p style=\{s\.muted\} data-testid="logo-loading">/);
});

test('QA #4: next invoice number goes through set_invoice_next_number; pending fallback; too-low message', async () => {
  const { parseNextNumber, validateBillingSettings: vb } = await import('../../app/lib/invoice.js');
  assert.deepEqual(parseNextNumber(' 1500 '), { value: 1500 });
  assert.ok(parseNextNumber('0').error && parseNextNumber('12a').error && parseNextNumber('123456789').error);
  assert.deepEqual(vb({ invoice_next_number: '1500' }), { patch: {}, nextNumber: 1500 });
  const withRpc = (role, uid, rpcImpl) => {
    const c = ctx(role, uid); const calls = [];
    const base = c.deps.mkUserClient();
    const uc = { ...base, rpc: async (fn, args) => { if (fn === 'packet_role') return base.rpc(fn); calls.push([fn, args]); return rpcImpl(c, args); } };
    return { c, calls, deps: { ...c.deps, mkUserClient: () => uc } };
  };
  // applied: RPC with the company owner id, fresh number returned
  let t = withRpc('management', MGMT, (c, a) => { c.svc.db.company_profiles[0].invoice_next_number = a.p_next; return { data: a.p_next, error: null }; });
  let r = await BILLING.PATCH(req('PATCH', { invoice_next_number: '1500', default_terms_days: '30' }), { deps: t.deps });
  assert.equal(r.status, 200);
  assert.deepEqual(t.calls, [['set_invoice_next_number', { p_owner: OWNER, p_next: 1500 }]]);
  assert.equal((await r.json()).settings.invoice_next_number, 1500);
  // unchanged number: no RPC
  t = withRpc('owner', OWNER, () => ({ data: null, error: null }));
  assert.equal((await BILLING.PATCH(req('PATCH', { invoice_next_number: 1001 }), { deps: t.deps })).status, 200);
  assert.equal(t.calls.length, 0);
  // not applied yet: 409 pending, other fields saved, number unchanged
  t = withRpc('owner', OWNER, () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.set_invoice_next_number' } }));
  r = await BILLING.PATCH(req('PATCH', { invoice_next_number: '1500', default_terms_days: '45' }), { deps: t.deps });
  const j = await r.json();
  assert.equal(r.status, 409); assert.equal(j.nextNumberPending, true); assert.match(j.error, /isn’t applied yet/);
  assert.equal(t.c.svc.db.company_profiles[0].default_terms_days, 45);
  assert.equal(t.c.svc.db.company_profiles[0].invoice_next_number, 1001);
  // too low
  t = withRpc('owner', OWNER, () => ({ data: null, error: { code: 'P0001', message: 'next_number_too_low:1003' } }));
  r = await BILLING.PATCH(req('PATCH', { invoice_next_number: '1002' }), { deps: t.deps });
  assert.equal(r.status, 422); assert.match((await r.json()).error, /at least INV-1003/);
  // bad input / dispatcher
  assert.equal((await BILLING.PATCH(req('PATCH', { invoice_next_number: 'abc' }), { deps: ctx('owner', OWNER).deps })).status, 422);
  assert.equal((await BILLING.PATCH(req('PATCH', { invoice_next_number: '2000' }), { deps: ctx('dispatcher', DISP).deps })).status, 403);
  const ui = read('../../app/company/CompanyBilling.js');
  assert.match(ui, /\{ro \? <p/); assert.match(ui, /data-testid="invoice-next-number"/); assert.match(ui, /data-testid="next-number-pending"/);
});
