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
// A PDF the reader decided isn't a rate con: shown as "Not a rate con · needs manual entry", not counted as waiting.
export const isNotRatecon = (d) => !!d && d.source === 'email' && !d.load_id && !d.ai_extracted_data && d.extraction_error === 'not_ratecon';
export const isEmailDraft = (d) => !!d && d.source === 'email' && !d.load_id && (!d.doc_type || d.doc_type === 'rate_confirmation') && !isNotRatecon(d);

export function emailReadProblem(reason) {
  return ({
    rate_limited: 'The rate con reader hit its hourly limit. Tap Run extraction later, or enter the load by hand.',
    not_ratecon: "This PDF doesn't look like a rate confirmation. Check it, then enter the load by hand.",
    nothing_read: "Couldn't read any load details. Enter the load by hand.",
    timeout: 'Reading timed out. Tap Run extraction to try again, or enter the load by hand.',
  })[reason] || "Couldn't read this rate con automatically. Tap Run extraction to try again, or enter the load by hand.";
}

export const REJECT_TEXT = { not_pdf: 'not a PDF', too_large: 'over the 10 MB limit', too_many: 'more than 10 PDFs in one email', empty: 'empty file', unreadable: 'unreadable', duplicate: 'already received' };
// Real ceiling: Vercel rejects webhook bodies over 4.5 MB (413) before our code runs, and Postmark sends files
// base64-encoded, so an email's attachments must total about 3 MB. Bigger emails never reach the app.
export const EMAIL_TOTAL_MB = 3;
export const skippedLine = (m) => `Skipped from email${m.subject ? ` “${m.subject}”` : ''}: ${(m.rejected_attachments || []).map((r) => `${r.name} (${REJECT_TEXT[r.reason] || r.reason})`).join(', ')}`;
// Dismissed skipped notices (inbound_emails ids), kept in this browser.
export const SKIPPED_DISMISS_KEY = 'ph_ratecon_skipped_dismissed';
export function readDismissed(storage) { try { const v = JSON.parse(storage?.getItem(SKIPPED_DISMISS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
export function addDismissed(storage, ids) { const next = [...new Set([...readDismissed(storage), ...ids])].slice(-50); try { storage?.setItem(SKIPPED_DISMISS_KEY, JSON.stringify(next)); } catch {} return next; }
export const visibleSkipped = (rows, dismissed) => (rows || []).filter((m) => Array.isArray(m.rejected_attachments) && m.rejected_attachments.length && !dismissed.includes(m.id));

// Copy text: Clipboard API when it exists and works, else select the node + execCommand('copy').
// → 'copied' | 'manual' (show "Press and hold the address to copy it.").
export async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document, node } = {}) {
  try { if (nav?.clipboard?.writeText) { await nav.clipboard.writeText(text); return 'copied'; } } catch {}
  try {
    if (doc && node) {
      const sel = doc.getSelection?.(); const range = doc.createRange?.();
      if (sel && range) { range.selectNodeContents(node); sel.removeAllRanges(); sel.addRange(range); }
      if (doc.execCommand?.('copy')) return 'copied';
    }
  } catch {}
  return 'manual';
}

// Sender allowlist text box → array ("a@x.com, @broker.com" or one per line).
export const parseSenders = (text) => String(text || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
