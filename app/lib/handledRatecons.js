// Rows a load delete stamps so an emailed rate con does not return to Docs > Needs attention
// once its load_id is cleared. The writer is public.mark_load_email_ratecons_handled
// (security definer). This is the same rule, used by tests and kept next to the call site.
export const MARK_LOAD_EMAIL_RATECONS_RPC = 'mark_load_email_ratecons_handled';

export function emailRateconHandledOnLoadDelete(doc, { loadId, ownerId, companyUserIds } = {}) {
  if (!doc || !loadId || doc.load_id !== loadId) return false;
  if (doc.source !== 'email' || doc.doc_type !== 'rate_confirmation') return false;
  if (doc.handled_at != null && doc.handled_at !== '') return false;
  if (!ownerId) return false;
  if (doc.user_id === ownerId) return true;
  return Array.isArray(companyUserIds) && companyUserIds.includes(doc.user_id);
}
