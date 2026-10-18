// Server helpers for /api/company/documents and the vault part of Send to broker (PR #84).
// Row security on documents stays own-rows (user_id = auth.uid()). The OWNER reads and writes with their own token,
// so RLS applies. Company members (management / dispatcher / driver) can't pass own-row RLS on the owner's rows, so
// their requests use the service client and EVERY query is filtered by user_id = ownerId (same as truckServer.js).
// Pick 2C is enforced HERE, before anything leaves the server: vaultForRole() strips W-9 / NOA to status only for
// dispatchers and drivers, and signedViewUrl() refuses them a file URL.
import { userClient, serviceClient, bearer, isAuthRejection } from './packetServer.js';
import { isRole } from './companyRoles.js';
import { VAULT_TYPE_IDS, isVaultType, groupVault, vaultForRole, canManageVault, canOpenVaultFile } from './companyDocs.js';
import { laToday } from './sendCap.js';

export const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
export const isMissing = (e) => !!e && (e.code === '42P01' || e.code === '42703' || e.code === 'PGRST204' || e.code === 'PGRST205' || /does not exist|Could not find the/i.test(e.message || ''));
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUCKET = 'documents';
const DOC_COLS = 'id,user_id,doc_type,file_path,original_filename,created_at,load_id';

// → { db, user, ownerId, role, profile, canManage } | { res }
export async function vaultCtx(req, { mkUserClient = userClient, sb: svc, mkService = serviceClient } = {}) {
  const token = bearer(req);
  if (!token) return { res: json({ error: 'Sign in first.' }, 401) };
  const uc = mkUserClient(token);
  const { data: u, error: uErr } = await uc.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return { res: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) };
  if (!u?.user) return { res: json({ error: 'Your sign-in expired. Please sign in again.' }, 401) };
  const { data: profiles, error } = await uc.from('company_profiles').select('*').limit(1);
  if (error && !isMissing(error)) return { res: json({ error: 'Could not load your company.' }, 500) };
  const profile = profiles?.[0] || null;
  const ownerId = profile?.owner_id || u.user.id;
  const { data: role } = await uc.rpc('packet_role', { p_owner: ownerId });
  if (!isRole(role)) return { res: json({ error: 'Not allowed.' }, 403) };
  let db = uc;
  if (ownerId !== u.user.id) {
    db = svc || mkService();
    if (!db) return { res: json({ error: 'Company documents aren’t set up for team members yet.' }, 503) };
  }
  return { db, user: u.user, ownerId, role, profile, canManage: canManageVault(role) };
}

// All vault rows of the owner (every version), newest first. → { docs } | { error }
export async function vaultDocs(db, ownerId) {
  let res;
  try { res = await db.from('documents').select(DOC_COLS).eq('user_id', ownerId).in('doc_type', VAULT_TYPE_IDS).order('created_at', { ascending: false }); }
  catch (e) { return { error: e }; }
  const { data, error } = res || {};
  if (error) return { error };
  return { docs: (data || []).filter((d) => d.user_id === ownerId && isVaultType(d.doc_type)) };
}
export async function vaultPolicies(db, ownerId) {
  try {
    const { data, error } = await db.from('insurance_policies').select('*').eq('owner_id', ownerId);
    return error ? [] : data || [];
  } catch { return []; } // Insurance not set up yet → the COI row just shows "Expiry not entered"
}

// The GET payload for one caller (role-shaped on the server).
export async function vaultPayload(c, { today = laToday() } = {}) {
  const r = await vaultDocs(c.db, c.ownerId);
  if (r.error) return { error: r.error };
  const policies = await vaultPolicies(c.db, c.ownerId);
  const groups = groupVault(r.docs);
  return { role: c.role, canManage: c.canManage, vault: vaultForRole(groups, c.role, { policies, profile: c.profile, today }) };
}

// One vault row of the owner, or null.
export async function ownedVaultDoc(db, ownerId, id) {
  if (!UUID.test(id || '')) return null;
  const { data } = await db.from('documents').select(DOC_COLS).eq('id', id).eq('user_id', ownerId).maybeSingle();
  return data && data.user_id === ownerId && isVaultType(data.doc_type) ? data : null;
}

// → { url } | { status, error }. Pick 2C read check happens here.
export async function signedViewUrl(c, id, { seconds = 120 } = {}) {
  const doc = await ownedVaultDoc(c.db, c.ownerId, id);
  if (!doc) return { status: 404, error: 'Document not found.' };
  if (!canOpenVaultFile(c.role, doc.doc_type)) return { status: 403, error: 'Only the owner or management can open the W-9 and NOA.' };
  const { data, error } = await c.db.storage.from(BUCKET).createSignedUrl(doc.file_path, seconds);
  if (error || !data?.signedUrl) return { status: 502, error: 'Couldn’t open the file. Please try again.' };
  return { url: data.signedUrl };
}

// Size in bytes of each storage path (null when unknown). One list() call per folder.
export async function fileSizes(db, paths = []) {
  const out = {};
  const byDir = new Map();
  for (const p of paths.filter(Boolean)) {
    const i = p.lastIndexOf('/');
    const dir = i > 0 ? p.slice(0, i) : '', name = p.slice(i + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }
  for (const [dir, names] of byDir) {
    for (const name of names) {
      out[dir ? `${dir}/${name}` : name] = null;
      try {
        const { data } = await db.storage.from(BUCKET).list(dir, { search: name, limit: 10 });
        const hit = (data || []).find((o) => o.name === name);
        const n = Number(hit?.metadata?.size);
        if (Number.isFinite(n)) out[dir ? `${dir}/${name}` : name] = n;
      } catch { /* unknown size; the send route re-checks the real bytes */ }
    }
  }
  return out;
}
