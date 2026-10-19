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
// Supabase Auth answers that mean "this token is no good" (sign in again), as opposed to "Auth couldn't answer".
// QA #100: a token whose session was ended elsewhere (sign-out on another device / tab: signOut() is global by
// default) makes GoTrue answer 403 session_not_found, which auth-js turns into AuthSessionMissingError with
// status 400 and the message "Auth session missing!". That matched none of the old checks, so it was treated as
// "Auth unavailable" → 503 on every call while online.
const AUTH_REJECT_CODES = new Set(['bad_jwt', 'session_not_found', 'session_expired', 'user_not_found', 'no_authorization', 'not_admin', 'user_banned', 'refresh_token_not_found', 'refresh_token_already_used']);
export const isAuthRejection = (e) => !!e && (e.status === 401 || e.status === 403 || e.name === 'AuthSessionMissingError' || AUTH_REJECT_CODES.has(e.code)
  || (/jwt|token|expired|invalid claim|not authenticated|session missing|session_not_found|session.*does not exist|user.*does not exist/i.test(e.message || '') && !(e.status >= 500)));
// "Auth couldn't answer": network failure, timeout, rate limit or a 5xx (auth-js: AuthRetryableFetchError, or
// AuthUnknownError when the body wasn't JSON, e.g. a gateway error page). Only these may fall back / return 503.
export function isAuthUnavailable(e) {
  if (!e) return false;
  if (e.name === 'AuthRetryableFetchError' || e.name === 'AuthUnknownError') return true;
  const st = Number(e.status);
  if (st === 0 || st === 408 || st === 429 || st >= 500) return true;
  if (e.status == null && !e.code && !e.name?.startsWith?.('Auth')) return true; // a thrown fetch/socket error
  return /fetch failed|failed to fetch|network|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed? ?out|other side closed/i.test(`${e.message || ''} ${e.cause?.code || ''}`);
}
// Short, token-free description of an Auth error for logs.
export const authErrInfo = (e) => [e?.name || '', e?.status ?? '', e?.code || e?.cause?.code || '', String(e?.message || e || '').slice(0, 160)].join(' ').trim();
export const bearer = (req) => (/^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '') || [])[1] || null;

// → { user, role, packet } | { status, error }. Role via public.packet_role (runs as the caller).
// Unverified JWT payload (only trusted after PostgREST has accepted the same token, see packetAccess).
export function jwtClaims(token) {
  try {
    const part = String(token || '').split('.')[1]; if (!part) return null;
    const json = typeof Buffer !== 'undefined' ? Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const c = JSON.parse(json); return c && typeof c === 'object' ? c : null;
  } catch { return null; }
}
const PGRST_JWT = new Set(['PGRST301', 'PGRST302', 'PGRST303']);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Supabase Auth check with one quick retry. → { user } | { rejected } | { unavailable, error }
export async function checkUser(uc, token, { retryMs = 250 } = {}) {
  let last = null;
  for (let i = 0; i < 2; i++) {
    try {
      const { data, error } = await uc.auth.getUser(token);
      if (!error) return data?.user ? { user: data.user } : { rejected: true };
      // Only a real network / timeout / 429 / 5xx failure is "unavailable"; any other answer from Auth is a rejection.
      if (!isAuthUnavailable(error)) return { rejected: true, error };
      last = error;
    } catch (e) { last = e; } // supabase-js can throw on a network error instead of returning one
    if (i === 0) await pause(retryMs);
  }
  return { unavailable: true, error: last };
}

// → { user, role, packet } | { status, error }. Role via public.packet_role (runs as the caller).
// If Supabase Auth itself can't answer (5xx, rate limit, network), the caller's token is still verified by the
// database: PostgREST checks the JWT signature on the packet_role call and rejects a bad/expired token. A packet
// page therefore never dead-ends on an Auth hiccup (preview QA, Oct 17).
export async function packetAccess(req, packetId, { sb, mkUserClient = userClient, authRetryMs } = {}) {
  const token = bearer(req);
  if (!token) return { status: 401, error: 'Sign in again.' };
  const uc = mkUserClient(token);
  const who = await checkUser(uc, token, authRetryMs != null ? { retryMs: authRetryMs } : {});
  if (who.rejected) return { status: 401, error: 'Sign in again.' };
  let user = who.user || null;
  if (who.unavailable) {
    const e = who.error;
    console.error('[packets] auth check unavailable, verifying via database', e?.status ?? '', e?.code ?? '', String(e?.message || e || '').slice(0, 160));
    const c = jwtClaims(token);
    if (!c?.sub) return { status: 503, error: 'Couldn’t check your sign-in just now. Try again.', retry: true }; // can't tell
    if ((c.exp && c.exp * 1000 < Date.now()) || (c.role && c.role !== 'authenticated')) return { status: 401, error: 'Sign in again.' }; // client refreshes + retries
    user = { id: c.sub, email: c.email || null, verified: 'database' };
  }
  if (!/^[0-9a-f-]{36}$/i.test(packetId || '')) return { status: 404, error: 'Packet not found.' };
  // select('*') so a missing optional column (migration not applied yet) can't make a packet look missing.
  const { data: packet, error: pErr } = await sb.from('packets').select('*').eq('id', packetId).maybeSingle();
  if (pErr) { console.error('[packets] load', pErr.code); return { status: 500, error: 'Could not load the packet. Please try again.' }; }
  if (!packet) return { status: 404, error: 'Packet not found.' };
  const { data: role, error: rErr } = await uc.rpc('packet_role', { p_owner: packet.owner_id });
  if (rErr && (PGRST_JWT.has(rErr.code) || isAuthRejection(rErr))) return { status: 401, error: 'Sign in again.' };
  if (rErr && who.unavailable) { console.error('[packets] role check', rErr.code); return { status: 503, error: 'Couldn’t check your sign-in just now. Try again.', retry: true }; }
  if (!isRole(role)) return { status: 404, error: 'Packet not found.' };
  return { user, role, packet, canEdit: canEdit(role) };
}

// Postgres "undefined column/table" → the 20261015001500 migration hasn't been applied.
export const MIGRATION = '20261015001500_packet_processing.sql';
export const isMissingSchema = (e) => !!e && (e.code === '42703' || e.code === '42P01' || e.code === 'PGRST204' || /column .* does not exist|Could not find the .* column/i.test(e.message || ''));
export const MISSING_MSG = 'Packet field detection needs a database update that hasn’t been applied yet. The packet itself is saved.';
