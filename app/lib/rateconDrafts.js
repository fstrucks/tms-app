// Client-safe helpers for rate cons that came in by email (no Node imports).
export const RATECON_DOMAIN = 'in.fstrucks.com';
export const RATECON_LOCAL = 'ratecon';
export const rateconAddress = (token) => (token ? `${RATECON_LOCAL}+${token}@${RATECON_DOMAIN}` : null);

export const PENDING_STALE_MS = 5 * 60 * 1000;
// null = not an email draft (uploaded, or already turned into a load).
// 'reading' = reader still running; 'ready' = fields read, review then Create load; 'manual' = read failed, file kept.
export function emailDraftState(d, now = Date.now()) {
  if (!d || d.source !== 'email' || d.load_id) return null;
  if (d.ai_extracted_data) return 'ready';
  if (d.extraction_status === 'pending' && now - new Date(d.created_at).getTime() < PENDING_STALE_MS) return 'reading';
  return 'manual';
}
export const isEmailDraft = (d) => !!d && d.source === 'email' && !d.load_id && (!d.doc_type || d.doc_type === 'rate_confirmation');

export function emailReadProblem(reason) {
  return ({
    rate_limited: 'The rate con reader hit its hourly limit. Tap Run extraction later, or enter the load by hand.',
    not_ratecon: "This PDF doesn't look like a rate confirmation. Check it, then enter the load by hand.",
    nothing_read: "Couldn't read any load details. Enter the load by hand.",
    timeout: 'Reading timed out. Tap Run extraction to try again, or enter the load by hand.',
  })[reason] || "Couldn't read this rate con automatically. Tap Run extraction to try again, or enter the load by hand.";
}

export const REJECT_TEXT = { not_pdf: 'not a PDF', too_large: 'over 10 MB', too_many: 'more than 10 PDFs in one email', empty: 'empty file', unreadable: 'unreadable' };

// Sender allowlist text box → array ("a@x.com, @broker.com" or one per line).
export const parseSenders = (text) => String(text || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
