import { createClient } from '@supabase/supabase-js';
import { loadKey, PacketKeyError } from '../../lib/packetCrypto';
import { buildRow, validateProfile, publicProfile } from '../../lib/companyProfile';
import { saveProfileGraceful, saveErrorMessage } from '../../lib/companyProfileSave';
import { roleFor, canEdit, canSign } from '../../lib/companyRoles';
import { noStoreFetch } from '../../lib/noStoreFetch';
import { pickProfile, readActiveCookie } from '../../lib/activeCompany';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Uses the caller's own token so RLS applies; no service role here.
async function ctx(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return { err: json({ error: 'Supabase is not configured.' }, 500) };
  if (!token) return { err: json({ error: 'Sign in first.' }, 401) };
  const sb = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` }, fetch: noStoreFetch }, auth: { persistSession: false } });
  const { data: u } = await sb.auth.getUser(token);
  if (!u?.user) return { err: json({ error: 'Your sign-in expired. Please sign in again.' }, 401) };
  const { data: members } = await sb.from('company_members').select('profile_id,user_id,role,created_at').eq('user_id', u.user.id);
  // A user can be in more than one company: use the active one (account menu → Company; cookie re-checked here
  // against the caller's own memberships), else the one they own, else the most recent join. See lib/activeCompany.
  const { data: profiles, error } = await sb.from('company_profiles').select('*').order('created_at', { ascending: true }).limit(50);
  if (error) return { err: json({ error: 'Could not load the company profile.' }, 500) };
  const profile = pickProfile(profiles, members, u.user.id, readActiveCookie(req)) || null;
  return { sb, user: u.user, profile, role: profile ? roleFor(u.user.id, profile, members || []) : 'owner' };
}

// Optional columns the database has (select('*') simply leaves a missing one out). null = no profile row to tell.
const columnsOf = (p) => ({ owner_name: p ? 'owner_name' in p : null });
const OWNER_NAME_PENDING = 'Saved, except Owner name: it needs a database update that hasn’t been applied yet.';

export async function GET(req) {
  const c = await ctx(req); if (c.err) return c.err;
  return json({ profile: publicProfile(c.profile), role: c.role, canEdit: canEdit(c.role), canSign: canSign(c.role), columns: columnsOf(c.profile) });
}

export async function PUT(req) {
  const c = await ctx(req); if (c.err) return c.err;
  if (!canEdit(c.role)) return json({ error: 'Drivers can view the company profile but not edit it.' }, 403);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const errors = validateProfile({ ...publicProfile(c.profile), ...body, ein: body.ein });
  if (Object.keys(errors).length) return json({ error: 'Please fix the highlighted fields.', errors }, 422);
  let key = null;
  if (body.ein) { try { key = loadKey(); } catch (e) { if (e instanceof PacketKeyError) { console.error('[company-profile]', e.message); return json({ error: 'EIN/TIN cannot be saved yet: server encryption key is not configured.' }, 503); } throw e; } }
  const row = buildRow(body, key);
  if (body.sign) {
    // Signing is a separate permission (drivers never; owner/dispatcher/management yes).
    if (!canSign(c.role)) return json({ error: 'Only the owner, dispatcher or management can sign.' }, 403);
    const path = String(body.signature_path || '');
    if (!path.startsWith(`${c.user.id}/company/`) || path.includes('..')) return json({ error: 'Bad signature file.' }, 400);
    if (!String(body.signer_name ?? c.profile?.signer_name ?? '').trim()) return json({ error: 'Enter the authorized signer name first.', errors: { signer_name: 'Required to sign.' } }, 422);
    Object.assign(row, { signature_path: path, signed_by: c.user.id, signed_at: new Date().toISOString() });
  }
  const { data, error, dropped = [] } = await saveProfileGraceful(c, row);
  if (error) {
    console.error('[company-profile] save', error.code, error.message);
    return json({ error: saveErrorMessage(error) }, error.code === '42501' ? 403 : 500);
  }
  return json({ profile: publicProfile(data), role: c.role, canEdit: true, canSign: canSign(c.role), columns: columnsOf(data),
    ...(dropped.includes('owner_name') && row.owner_name ? { notice: OWNER_NAME_PENDING } : {}) });
}

