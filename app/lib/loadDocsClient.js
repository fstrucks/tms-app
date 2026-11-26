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
export async function fetchTeamDocs(supabase, { fetchImpl = (...a) => fetch(...a), inbox = false } = {}) {
  try {
    const res = await authedFetch(supabase.auth, inbox ? '/api/documents/team?inbox=1' : '/api/documents/team', { cache: 'no-store' }, { fetchImpl });
    const j = await res.json().catch(() => ({}));
    if (res.ok) return inbox ? { data: j.documents || [], more: !!j.more, error: null } : { data: j.documents || [], error: null };
    return { data: null, error: { status: res.status, message: j.error || null } };
  } catch (e) { return { data: null, error: { message: String(e?.message || e) } }; }
}

// Documents panel (load page + LoadDocsCard): 'loading' until the first fetch for this load resolves (docs === null)
// or while a re-fetch runs with nothing to show; 'empty' only after a completed fetch returned no rows.
export const docsPanelState = (docs, busy) => (docs == null || (busy && docs.length === 0) ? 'loading' : docs.length === 0 ? 'empty' : 'list');

// Same open path as the load page Documents section: use the signed URL from /api/loads/:id/documents
// when present (works for team uploads the viewer doesn't own); otherwise sign the viewer's own file.
export async function openLoadDoc(supabase, doc, { open } = {}) {
  const go = open || ((url) => window.open(url, '_blank', 'noopener'));
  if (doc?.url) { go(doc.url); return { ok: true }; }
  if (doc?.file_path && supabase?.storage) {
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(doc.file_path, 300);
    if (data?.signedUrl) { go(data.signedUrl); return { ok: true }; }
    return { ok: false, error };
  }
  return { ok: false };
}
