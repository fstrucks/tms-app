// Docs tab "Needs attention": documents nobody has acted on yet.
// Acted on means reviewed or confirmed, or attached to a load, a driver, equipment, or the company.
// Filed paperwork stays in its vault (Load, Driver, Company, Maintenance). This list does not load that history.
//
// A document still needs attention when either of these is true:
//   1. It is an unreviewed rate con: the existing review-pending state (isEmailDraft).
//      That is an email row with no load, type unset or rate confirmation, and not marked "not a rate con".
//   2. It is an upload (source is upload, or missing — older rows default to upload) with no assignment.
//
// It stops needing attention when either of these is true:
//   - Reviewed or confirmed. An email rate con leaves review-pending once a load is created, the type
//     changes, it is marked not a rate con, or handled_at is set (its load was deleted; the file stays).
//     A scale ticket linked to the file with confirmed = true is confirmed.
//   - Attached. documents.load_id (load), documents.truck_id or documents.service_record_id (equipment /
//     maintenance), a checklist file path ({owner}/checklist/{type}/{driver|truck|trailer|company}/…),
//     a company vault path ({owner}/company/…), a company doc type (W-9, COI, MC Authority, NOA),
//     or a scale_tickets row whose document_id points here and carries a load, truck, or trailer.
//
// handled_at is the only added column. Callers still read documents and scale_tickets. RLS is unchanged.
import { isEmailDraft, isHandledDoc } from './rateconDrafts';
import { isCompanyDocType, isDocumentsTabDoc } from './docTypes';
import { scopeIdOf } from './setupProgress';

export const INBOX_ATTENTION_CAP = 40;
export const INBOX_ATTENTION_FETCH = 80;
export const INBOX_OPEN_KEY = 'ph_docs_inbox_open';
export const DOCS_ATTENTION_EVENT = 'ph-docs-attention';

const FULL_COLS = 'id, user_id, doc_type, file_path, original_filename, created_at, ai_extracted_data, load_id, truck_id, service_record_id, source, extraction_status, extraction_error, handled_at';
const MID_COLS = 'id, user_id, doc_type, file_path, original_filename, created_at, ai_extracted_data, load_id, truck_id, service_record_id, source, extraction_status, extraction_error';
const BASE_COLS = 'id, user_id, doc_type, file_path, original_filename, created_at, ai_extracted_data, load_id, truck_id';

export function readInboxOpen(storage) {
  try {
    return storage?.getItem(INBOX_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeInboxOpen(storage, open) {
  try { storage?.setItem(INBOX_OPEN_KEY, open ? '1' : '0'); } catch { /* private mode */ }
  return !!open;
}

export function attentionLabel(n) {
  const c = Number(n) || 0;
  if (c <= 0) return 'Nothing waiting for review';
  if (c === 1) return '1 waiting for review';
  return `${c} waiting for review`;
}

// The Docs tab icon listens for this. The page publishes the count of the list on screen.
export function publishAttentionCount(count) {
  const n = Math.max(0, Number(count) || 0);
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOCS_ATTENTION_EVENT, { detail: { count: n } }));
  } catch { /* no window */ }
  return n;
}

export function hasAssignment(doc, link = null) {
  if (!doc) return false;
  if (doc.load_id || link?.load_id) return true;
  if (doc.truck_id || doc.service_record_id) return true;
  if (link?.truck_id || link?.trailer_id) return true;
  if (isCompanyDocType(doc.doc_type)) return true;
  const path = String(doc.file_path || '');
  if (path.includes('/company/')) return true;
  if (scopeIdOf(doc)) return true;
  return false;
}

// Reviewed: email row that is no longer review-pending. Confirmed: linked scale ticket confirmed = true.
export function isReviewedOrConfirmed(doc, link = null) {
  if (!doc) return false;
  if (link?.confirmed) return true;
  if (doc.source === 'email' && !isEmailDraft(doc)) return true;
  return false;
}

export function needsAttention(doc, link = null) {
  if (!doc || doc.doc_type === 'receipt') return false;
  if (isHandledDoc(doc)) return false;
  if (!isDocumentsTabDoc(doc)) return false;
  if (isReviewedOrConfirmed(doc, link)) return false;
  if (hasAssignment(doc, link)) return false;
  if (isEmailDraft(doc)) return true;
  if (doc.source === 'email') return false;
  return true;
}

export function selectNeedsAttention(docs, tickets = []) {
  const byId = new Map();
  for (const t of tickets || []) {
    if (t?.document_id && !byId.has(t.document_id)) byId.set(t.document_id, t);
  }
  const seen = new Set();
  const out = [];
  for (const d of docs || []) {
    if (!d?.id || seen.has(d.id)) continue;
    seen.add(d.id);
    if (!needsAttention(d, byId.get(d.id) || null)) continue;
    out.push(d);
  }
  return out;
}

function attentionQuery(supabase, cols, { service = false, handled = false } = {}) {
  let q = supabase.from('documents').select(cols).is('load_id', null).is('truck_id', null);
  if (service) q = q.is('service_record_id', null);
  if (handled) q = q.is('handled_at', null);
  // Checklist and company paths are already filed. The predicate checks them again.
  return q.not('file_path', 'like', '%/checklist/%').not('file_path', 'like', '%/company/%')
    .order('created_at', { ascending: false })
    .limit(INBOX_ATTENTION_FETCH);
}

// Own rows, plus company email drafts RLS already returns to the office. No user_id filter here.
export async function fetchNeedsAttention(supabase) {
  if (!supabase?.from) return { documents: [], more: false, error: null };
  let res = await attentionQuery(supabase, FULL_COLS, { service: true, handled: true });
  // Missing handled_at: keep service_record_id. Missing that too: the older column list.
  if (res.error?.code === '42703') res = await attentionQuery(supabase, MID_COLS, { service: true, handled: false });
  if (res.error?.code === '42703') res = await attentionQuery(supabase, BASE_COLS, { service: false, handled: false });
  if (res.error) return { documents: [], more: false, error: res.error };
  const rows = res.data || [];
  const ids = rows.map((d) => d.id).filter(Boolean);
  let tickets = [];
  if (ids.length) {
    const tk = await supabase.from('scale_tickets').select('document_id, load_id, truck_id, trailer_id, confirmed').in('document_id', ids);
    if (!tk.error) tickets = tk.data || [];
  }
  const matched = selectNeedsAttention(rows, tickets);
  return {
    documents: matched.slice(0, INBOX_ATTENTION_CAP),
    more: matched.length > INBOX_ATTENTION_CAP,
    error: null,
  };
}
