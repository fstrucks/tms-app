// Server helpers for /api/packets/*: service client, caller identity, caller's role on the packet.
import { createClient } from '@supabase/supabase-js';
import { canEdit, isRole } from './companyRoles.js';

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
}
export function userClient(token) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
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
  const { data: packet } = await sb.from('packets').select('id,owner_id,status,subject,original_filename,source,file_path,page_count,has_text_layer,manual_reason,process_error,created_at').eq('id', packetId).maybeSingle();
  if (!packet) return { status: 404, error: 'Packet not found.' };
  const { data: role } = await uc.rpc('packet_role', { p_owner: packet.owner_id });
  if (!isRole(role)) return { status: 404, error: 'Packet not found.' };
  return { user: u.user, role, packet, canEdit: canEdit(role) };
}
