import { authedFetch } from './authedFetch';
// Load page: this load's documents from /api/loads/:id/documents (includes team members' uploads and Truck-tab
// scale tickets, with signed URLs). If the endpoint isn't available (older server, no service key) it falls back
// to the old direct query, which only returns your own uploads. → { data, error } like a Supabase query.
export async function fetchLoadDocs(supabase, loadId, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const res = await authedFetch(supabase.auth, `/api/loads/${loadId}/documents`, { cache: 'no-store' }, { fetchImpl });
    if (res.ok) { const j = await res.json(); return { data: j.documents || [], error: null }; }
    if (res.status !== 503 && res.status !== 404) return { data: null, error: { status: res.status } };
  } catch { /* fall back */ }
  return supabase.from('documents').select('id, doc_type, file_path, original_filename, created_at').eq('load_id', loadId).order('created_at', { ascending: false });
}

// Documents tab "Team" view (/api/documents/team). → { data, error }
export async function fetchTeamDocs(supabase, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const res = await authedFetch(supabase.auth, '/api/documents/team', { cache: 'no-store' }, { fetchImpl });
    const j = await res.json().catch(() => ({}));
    if (res.ok) return { data: j.documents || [], error: null };
    return { data: null, error: { status: res.status, message: j.error || null } };
  } catch (e) { return { data: null, error: { message: String(e?.message || e) } }; }
}
