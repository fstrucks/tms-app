// Load page: this load's documents from /api/loads/:id/documents (includes team members' uploads and Truck-tab
// scale tickets, with signed URLs). If the endpoint isn't available (older server, no service key) it falls back
// to the old direct query, which only returns your own uploads. → { data, error } like a Supabase query.
export async function fetchLoadDocs(supabase, loadId, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetchImpl(`/api/loads/${loadId}/documents`, { cache: 'no-store', headers: { Authorization: `Bearer ${s?.session?.access_token || ''}` } });
    if (res.ok) { const j = await res.json(); return { data: j.documents || [], error: null }; }
    if (res.status !== 503 && res.status !== 404) return { data: null, error: { status: res.status } };
  } catch { /* fall back */ }
  return supabase.from('documents').select('id, doc_type, file_path, original_filename, created_at').eq('load_id', loadId).order('created_at', { ascending: false });
}
