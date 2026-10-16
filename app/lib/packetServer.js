// Server helpers for /api/packets/*: service client, caller identity, caller's role on the packet.
import { createClient } from '@supabase/supabase-js';
import { canEdit, isRole } from './companyRoles.js';
import { noStoreFetch } from './noStoreFetch.js';

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false }, global: { fetch: noStoreFetch } }) : null;
}
export function userClient(token) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` }, fetch: noStoreFetch } });
}
export const bearer = (req) => (/^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '') || [])[1] || null;

// → { user, role, packet } | { status, error }. Role via public.packet_role (runs as the caller).
export async function packetAccess(req, packetId, { sb, mkUserClient = userClient } = {}) {
  const token = bearer(req);
  if (!token) return { status: 401, error: 'Sign in again.' };
  const uc = mkUserClient(token);
  const { data: u } = await uc.auth.getUser(token);
  if (!u?.user) return { status: 401, error: 'Sign in again.' };
  if (!/^[0-9a-f-]{36}$/i.test(packetId || '')) return { status: 404, error: 'Packet not found.' };
  // select('*') so a missing optional column (migration not applied yet) can't make a packet look missing.
  const { data: packet, error: pErr } = await sb.from('packets').select('*').eq('id', packetId).maybeSingle();
  if (pErr) { console.error('[packets] load', pErr.code); return { status: 500, error: 'Could not load the packet. Please try again.' }; }
  if (!packet) return { status: 404, error: 'Packet not found.' };
  const { data: role } = await uc.rpc('packet_role', { p_owner: packet.owner_id });
  if (!isRole(role)) return { status: 404, error: 'Packet not found.' };
  return { user: u.user, role, packet, canEdit: canEdit(role) };
}

// Postgres "undefined column/table" → the 20261015001500 migration hasn't been applied.
export const MIGRATION = '20261015001500_packet_processing.sql';
export const isMissingSchema = (e) => !!e && (e.code === '42703' || e.code === '42P01' || e.code === 'PGRST204' || /column .* does not exist|Could not find the .* column/i.test(e.message || ''));
export const MISSING_MSG = 'Packet field detection needs a database update that hasn’t been applied yet. The packet itself is saved.';
