// Docs tab inbox: rate cons waiting for review, plus a short list of recent uploads.
// The full history lives on the vault pages. This module does not load that history.
import { isEmailDraft } from './rateconDrafts';

export const INBOX_RECENT_DAYS = 7;
export const INBOX_RECENT_CAP = 10;
export const INBOX_WAITING_CAP = 40;
export const INBOX_OPEN_KEY = 'ph_docs_inbox_open';

const WAITING_COLS = 'id, user_id, doc_type, file_path, original_filename, created_at, ai_extracted_data, load_id, source, extraction_status, extraction_error';

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

// Waiting rate cons first (any age, capped), then recent uploads that are not already listed.
export function mergeInboxDocs(recent, waiting, { cap = INBOX_RECENT_CAP } = {}) {
  const seen = new Set();
  const wait = [];
  for (const d of waiting || []) {
    if (!isEmailDraft(d) || !d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    wait.push(d);
    if (wait.length >= INBOX_WAITING_CAP) break;
  }
  const rec = [];
  for (const d of recent || []) {
    if (!d?.id || seen.has(d.id)) continue;
    seen.add(d.id);
    rec.push(d);
    if (rec.length >= cap) break;
  }
  return [...wait, ...rec];
}

// Email drafts with no load yet. RLS decides which rows the caller may see; this does not filter by user.
export async function fetchWaitingRateCons(supabase) {
  if (!supabase?.from) return [];
  const { data, error } = await supabase.from('documents').select(WAITING_COLS)
    .eq('source', 'email').is('load_id', null)
    .or('doc_type.is.null,doc_type.eq.rate_confirmation')
    .order('created_at', { ascending: false })
    .limit(INBOX_WAITING_CAP);
  if (error) return [];
  return (data || []).filter(isEmailDraft);
}
