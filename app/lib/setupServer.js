// Server helpers for /api/setup. The caller's token is used for checklist rows so RLS applies.
// Trucks, drivers, and the owner's documents are own-row tables, so a teammate's read uses the service
// client and every query is filtered by the company owner's id (same pattern as the Truck tab).
import { userClient, serviceClient, bearer, isAuthRejection } from './packetServer.js';
import { pickProfile, readActiveCookie } from './activeCompany.js';
import { roleFor } from './companyRoles.js';
import { isMissing } from './vaultServer.js';
import { laToday } from './sendCap.js';
import { coiExpiry } from './companyDocs.js';
import { CHECKLIST_ITEMS, itemByKey, OPERATION_QUESTIONS } from './setupCatalog.js';
import { setupEntry, scopeIdOf } from './setupProgress.js';
import { isISODate } from './complianceCalendar.js';

export const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUCKET = 'documents';
// Office is owner, dispatcher, and management — the same roles that can edit the company profile.
export const isOffice = (role) => role === 'owner' || role === 'dispatcher' || role === 'management';

const DOC_TYPES = [...new Set(CHECKLIST_ITEMS.map((i) => i.docType).filter(Boolean))];
const DRIVER_DOC_TYPES = new Set(['coi', 'medical_card', 'cab_card', 'ifta_license', 'annual_inspection', 'permit', 'carrier_lease']);
const PROFILE_KEYS = ['id', 'owner_id', 'legal_name', 'dba_name', 'owner_name', 'mc_number', 'dot_number', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'phone', 'email', 'created_at', 'setup_started_at', 'setup_completed_at', 'setup_dismissed_at', 'setup_prompted_at', 'operation_answers', 'ifta_renewal_on', 'irp_renewal_on', 'hvut_first_use_on'];

export function publicSetupProfile(p) {
  if (!p) return null;
  const out = {};
  for (const k of PROFILE_KEYS) if (k in p || k === 'operation_answers') out[k] = p[k] ?? (k === 'operation_answers' ? {} : null);
  if (!out.operation_answers || typeof out.operation_answers !== 'object') out.operation_answers = {};
  return out;
}
const cleanDate = (v) => (v == null || v === '' ? null : isISODate(v) ? v : undefined);
const cleanNote = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 500); return s || null; };

export async function setupCtx(req, deps = {}) {
  const token = bearer(req);
  if (!token) return { res: json({ error: 'Sign in first.' }, 401) };
  const uc = (deps.mkUserClient || userClient)(token);
  const { data: u, error: uErr } = await uc.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return { res: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) };
  if (!u?.user) return { res: json({ error: 'Your sign-in expired. Please sign in again.' }, 401) };
  const { data: members, error: mErr } = await uc.from('company_members').select('profile_id,user_id,role,created_at').eq('user_id', u.user.id);
  if (mErr && !isMissing(mErr)) return { res: json({ error: 'Could not load your company.' }, 500) };
  const { data: profiles, error } = await uc.from('company_profiles').select('*').order('created_at', { ascending: true }).limit(50);
  if (error && !isMissing(error)) return { res: json({ error: 'Could not load your company.' }, 500) };
  const profile = pickProfile(profiles, members || [], u.user.id, readActiveCookie(req, u.user.id)) || null;
  const role = profile ? roleFor(u.user.id, profile, members || []) : null;
  const svc = deps.sb || (deps.mkService || serviceClient)();
  const db = profile && profile.owner_id !== u.user.id ? svc : uc;
  return { uc, db, svc, user: u.user, profile, role, office: isOffice(role), ownerId: profile?.owner_id || null };
}

async function rowsOf(q) {
  try {
    const { data, error } = await q;
    if (error) return { error };
    return { rows: data || [] };
  } catch (error) { return { error }; }
}

export async function loadSetup(c, { today = laToday() } = {}) {
  if (!c.profile) return { needsProfile: true, role: c.role, today };
  const companyId = c.profile.id;
  const statusQ = await rowsOf(c.uc.from('company_checklist_status').select('*').eq('company_id', companyId));
  if (statusQ.error) {
    if (isMissing(statusQ.error)) return { setupNeeded: true, role: c.role, today, profile: publicSetupProfile(c.profile) };
    return { error: 'Could not load the checklist.' };
  }
  const db = c.db;
  let trucks = [], trailers = [], drivers = [], documents = [], reminders = [], coi = null, limited = false;
  if (!db) limited = true;
  else {
    const tr = await rowsOf(db.from('trucks').select('id,unit_number,current_trailer_id').eq('user_id', c.ownerId).order('unit_number'));
    const tl = await rowsOf(db.from('trailers').select('id,unit_number').eq('user_id', c.ownerId).order('unit_number'));
    const dr = await rowsOf(db.from('drivers').select('id,name,truck_id,auth_user_id,cdl_expiry,med_card_expiry,active').eq('user_id', c.ownerId).eq('active', true));
    const docs = await rowsOf(db.from('documents').select('id,doc_type,truck_id,file_path,original_filename,created_at,user_id').eq('user_id', c.ownerId).in('doc_type', DOC_TYPES).order('created_at', { ascending: false }));
    const rem = await rowsOf(c.uc.from('compliance_reminders_state').select('*').eq('company_id', companyId));
    if (!tr.error) trucks = tr.rows; else if (!isMissing(tr.error)) return { error: 'Could not load trucks.' };
    if (!tl.error) trailers = tl.rows;
    if (!dr.error) drivers = dr.rows;
    if (!docs.error) documents = docs.rows.filter((d) => d.user_id === c.ownerId && DOC_TYPES.includes(d.doc_type));
    else if (!isMissing(docs.error)) return { error: 'Could not load documents.' };
    if (!rem.error) reminders = rem.rows; else if (!isMissing(rem.error)) reminders = [];
    try {
      const pol = await db.from('insurance_policies').select('coverage,expiry_date,effective_date,confirmed,limit_amount').eq('owner_id', c.ownerId);
      if (!pol.error) coi = coiExpiry(pol.data || [], today);
    } catch { coi = null; }
  }
  let loads = 0;
  if (db) {
    const ld = await rowsOf(db.from('loads').select('id').eq('user_id', c.ownerId).limit(1));
    if (!ld.error && ld.rows.length) loads = ld.rows.length;
  }
  const pulled = new Map();
  for (const t of trucks) if (t.current_trailer_id) pulled.set(t.current_trailer_id, t.id);
  const activity = { trucks: trucks.length, drivers: drivers.length, documents: documents.length, loads };
  const people = await loadPeople(c, markerIds(statusQ.rows, documents), drivers);
  const payload = {
    role: c.role, office: c.office, today, limited, coiExpiry: coi,
    profile: publicSetupProfile(c.profile),
    entry: c.office ? setupEntry(c.profile, c.role, Date.now(), activity) : null,
    trucks, drivers,
    trailers: trailers.map((t) => ({ ...t, pulled_by: pulled.get(t.id) || null })),
    documents, statuses: statusQ.rows, reminders, people,
  };
  return shapeForRole(payload, c);
}

function markerIds(statuses, documents) {
  const ids = new Set();
  for (const s of statuses || []) if (s.checked_by) ids.add(s.checked_by);
  for (const d of documents || []) if (d.user_id) ids.add(d.user_id);
  return [...ids];
}

function rememberPerson(people, id, patch) {
  if (!id) return;
  const cur = people[id] || {};
  const name = String(patch.name || '').trim();
  const email = String(patch.email || '').trim();
  people[id] = { name: name || cur.name || null, email: email || cur.email || null };
}

// Name, then email, from the company profile, driver row, and the auth user behind a member.
async function loadPeople(c, ids, drivers) {
  const people = {};
  const owner = c.profile;
  if (owner?.owner_id) rememberPerson(people, owner.owner_id, { name: owner.owner_name, email: owner.email });
  if (c.user?.id) rememberPerson(people, c.user.id, { name: c.user.user_metadata?.full_name || c.user.user_metadata?.name, email: c.user.email });
  for (const d of drivers || []) if (d.auth_user_id && d.name) rememberPerson(people, d.auth_user_id, { name: d.name });
  const admin = c.svc?.auth?.admin;
  if (admin?.getUserById) {
    for (const id of ids) {
      if (people[id]?.name && people[id]?.email) continue;
      try {
        const { data } = await admin.getUserById(id);
        const u = data?.user;
        if (!u) continue;
        rememberPerson(people, id, { name: u.user_metadata?.full_name || u.user_metadata?.name, email: u.email });
      } catch { /* a missing name does not block the checklist */ }
    }
  }
  const keep = new Set(ids);
  return Object.fromEntries(Object.entries(people).filter(([id]) => keep.has(id)));
}

function shapeForRole(payload, c) {
  if (c.role !== 'driver') return payload;
  const mine = payload.drivers.find((d) => d.auth_user_id === c.user.id) || null;
  const trucks = mine?.truck_id ? payload.trucks.filter((t) => t.id === mine.truck_id) : payload.trucks;
  const truckIds = new Set(trucks.map((t) => t.id));
  const documents = payload.documents.filter((d) => DRIVER_DOC_TYPES.has(d.doc_type)).map((d) => ({
    id: d.id, doc_type: d.doc_type, truck_id: d.truck_id || null, user_id: d.user_id || null, created_at: d.created_at, scope_id: scopeIdOf(d),
  }));
  const statuses = payload.statuses.filter((s) => {
    const item = itemByKey(s.item_key);
    if (!item) return false;
    const visible = item.driverAccess === 'equipment' || item.driverAccess === 'binder' || DRIVER_DOC_TYPES.has(item.docType);
    if (!visible) return false;
    if (s.truck_id && !truckIds.has(s.truck_id)) return false;
    return true;
  }).map((s) => ({ ...s, note: null }));
  const visiblePeople = new Set([...statuses.map((s) => s.checked_by), ...documents.map((d) => d.user_id)].filter(Boolean));
  return {
    ...payload,
    office: false,
    entry: null,
    reminders: [],
    trucks,
    drivers: mine ? [mine] : [],
    trailers: payload.trailers.filter((t) => truckIds.has(t.pulled_by)),
    documents, statuses,
    people: Object.fromEntries(Object.entries(payload.people || {}).filter(([id]) => visiblePeople.has(id))),
  };
}

async function existingStatus(uc, companyId, body) {
  let q = uc.from('company_checklist_status').select('id').eq('company_id', companyId).eq('item_key', body.itemKey);
  q = body.truckId ? q.eq('truck_id', body.truckId) : q.is('truck_id', null);
  q = body.trailerId ? q.eq('trailer_id', body.trailerId) : q.is('trailer_id', null);
  q = body.driverId ? q.eq('driver_id', body.driverId) : q.is('driver_id', null);
  const { data, error } = await q.maybeSingle();
  return { id: data?.id || null, error };
}

export async function saveStatus(c, body) {
  if (!c.office && c.role !== 'driver') return { status: 403, error: 'You can’t update the checklist.' };
  const item = itemByKey(body?.itemKey);
  if (!item || item.echoOf) return { status: 422, error: 'That checklist item is not on the list.' };
  const status = body.status;
  if (!['done', 'not_yet', 'not_needed', 'skipped'].includes(status)) return { status: 422, error: 'Pick a status.' };
  if (status === 'not_needed' && item.level === 'required') return { status: 422, error: 'A required item stays on the list. You can skip it, and it still shows as missing.' };
  const truckId = UUID.test(body.truckId || '') ? body.truckId : null;
  const trailerId = UUID.test(body.trailerId || '') ? body.trailerId : null;
  const driverId = UUID.test(body.driverId || '') ? body.driverId : null;
  if (c.role === 'driver') {
    if (item.driverAccess !== 'equipment') return { status: 403, error: 'Drivers can check equipment only.' };
    if (!truckId) return { status: 422, error: 'Pick the truck.' };
  }
  const row = {
    company_id: c.profile.id, item_key: item.key, truck_id: truckId, trailer_id: trailerId, driver_id: driverId,
    status, checked_by: c.user.id, checked_at: new Date().toISOString(), note: cleanNote(body.note),
  };
  if (body && Object.prototype.hasOwnProperty.call(body, 'expiryOn')) {
    const expiry = cleanDate(body.expiryOn);
    if (expiry === undefined) return { status: 422, error: 'Enter the date as YYYY-MM-DD.' };
    row.expiry_on = expiry;
  }
  const found = await existingStatus(c.uc, c.profile.id, { itemKey: item.key, truckId, trailerId, driverId });
  if (found.error) return { status: isMissing(found.error) ? 503 : 500, error: isMissing(found.error) ? 'The checklist needs a database update that hasn’t been applied yet.' : 'Could not save that item.' };
  const write = found.id
    ? await c.uc.from('company_checklist_status').update(row).eq('id', found.id).eq('company_id', c.profile.id)
    : await c.uc.from('company_checklist_status').insert(row);
  if (write.error) {
    if (write.error.code === '42501') return { status: 403, error: 'You can only check equipment on your truck.' };
    return { status: 500, error: 'Could not save that item.' };
  }
  return { ok: true };
}

export async function saveSetupProfile(c, body) {
  if (!c.office) return { status: 403, error: 'Only the office can update company setup.' };
  const answers = {};
  const incoming = body.answers && typeof body.answers === 'object' ? body.answers : {};
  for (const q of OPERATION_QUESTIONS) if (incoming[q.key] === true || incoming[q.key] === false) answers[q.key] = incoming[q.key];
  const kept = body.replaceAnswers ? {} : { ...(c.profile.operation_answers || {}) };
  const patch = { operation_answers: { ...kept, ...answers } };
  for (const [key, col] of [['iftaRenewalOn', 'ifta_renewal_on'], ['irpRenewalOn', 'irp_renewal_on'], ['hvutFirstUseOn', 'hvut_first_use_on']]) {
    if (!(key in body)) continue;
    const d = cleanDate(body[key]);
    if (d === undefined) return { status: 422, error: 'Enter the date as YYYY-MM-DD.' };
    patch[col] = d;
  }
  const upd = await c.uc.from('company_profiles').update(patch).eq('id', c.profile.id).select('id').single();
  if (upd.error) return { status: isMissing(upd.error) ? 503 : 500, error: isMissing(upd.error) ? 'The checklist needs a database update that hasn’t been applied yet.' : 'Could not save those answers.' };
  return { ok: true };
}

export async function touchSetup(c, action) {
  if (!c.office) return { status: 403, error: 'Only the office can update company setup.' };
  const now = new Date().toISOString();
  const patch = {};
  if (action === 'start' && !c.profile.setup_started_at) patch.setup_started_at = now;
  if (action === 'prompt') patch.setup_prompted_at = now;
  if (action === 'dismiss') patch.setup_dismissed_at = now;
  if (!Object.keys(patch).length) return { ok: true };
  const upd = await c.uc.from('company_profiles').update(patch).eq('id', c.profile.id);
  if (upd.error) return { status: isMissing(upd.error) ? 503 : 500, error: isMissing(upd.error) ? 'The checklist needs a database update that hasn’t been applied yet.' : 'Could not save.' };
  return { ok: true };
}

export async function saveReminder(c, body) {
  if (!c.office) return { status: 403, error: 'Only the office can update the calendar.' };
  const ruleKey = String(body.ruleKey || '').trim().slice(0, 80);
  const period = String(body.period || '').trim().slice(0, 120);
  if (!ruleKey || !period) return { status: 422, error: 'Missing reminder.' };
  if (!['completed', 'dismissed'].includes(body.status)) return { status: 422, error: 'Pick complete or dismiss.' };
  const truckId = UUID.test(body.truckId || '') ? body.truckId : null;
  let q = c.uc.from('compliance_reminders_state').select('id').eq('company_id', c.profile.id).eq('rule_key', ruleKey).eq('period', period);
  q = truckId ? q.eq('truck_id', truckId) : q.is('truck_id', null);
  const found = await q.maybeSingle();
  if (found.error) return { status: isMissing(found.error) ? 503 : 500, error: isMissing(found.error) ? 'The calendar needs a database update that hasn’t been applied yet.' : 'Could not update the calendar.' };
  const row = { company_id: c.profile.id, rule_key: ruleKey, period, truck_id: truckId, status: body.status, acted_by: c.user.id, acted_at: new Date().toISOString() };
  const write = found.data?.id
    ? await c.uc.from('compliance_reminders_state').update(row).eq('id', found.data.id).eq('company_id', c.profile.id)
    : await c.uc.from('compliance_reminders_state').insert(row);
  if (write.error) return { status: write.error.code === '42501' ? 403 : 500, error: write.error.code === '42501' ? 'You can’t update the calendar.' : 'Could not update the calendar.' };
  return { ok: true };
}

export function checklistPath(ownerId, docType, scopeId, filename, now = Date.now()) {
  const safe = String(filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'file';
  const scope = String(scopeId || 'company').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'company';
  return `${ownerId}/checklist/${docType}/${scope}/${now}-${safe}`;
}
export function isChecklistPath(ownerId, docType, path) {
  return typeof path === 'string' && path.startsWith(`${ownerId}/checklist/${docType}/`) && !path.includes('..');
}
