// Client-safe helpers for rate cons that came in by email (no Node imports).
// Inbound mail is accepted on both domains, so ratecon+<token>@ addresses keep working on either one.
// in.pwrstrong.net needs its MX record and Postmark inbound domain first, so the app keeps showing
// in.fstrucks.com until NEXT_PUBLIC_INBOUND_DOMAIN=in.pwrstrong.net is set.
export const INBOUND_DOMAINS = ['in.fstrucks.com', 'in.pwrstrong.net'];
export const shownInboundDomain = (v) => { const d = String(v || '').trim().toLowerCase(); return INBOUND_DOMAINS.includes(d) ? d : INBOUND_DOMAINS[0]; };
export const RATECON_DOMAIN = shownInboundDomain(process.env.NEXT_PUBLIC_INBOUND_DOMAIN);
export const INBOUND_ADDRESS = `packets@${RATECON_DOMAIN}`;
export const RATECON_LOCAL = 'ratecon';
export const rateconAddress = (token) => (token ? `${RATECON_LOCAL}+${token}@${RATECON_DOMAIN}` : null);

export const PENDING_STALE_MS = 5 * 60 * 1000;
// null = not an email draft (uploaded, already a load, or handled_at set when that load was deleted).
// 'reading' = reader still running; 'ready' = fields read, review then Create load; 'manual' = read failed, file kept.
// The file stays. A handled row is not waiting for review.
export const isHandledDoc = (d) => !!d && d.handled_at != null && d.handled_at !== '';
export function emailDraftState(d, now = Date.now()) {
  if (!d || d.source !== 'email' || d.load_id || isHandledDoc(d)) return null;
  if (d.ai_extracted_data) return 'ready';
  if (d.extraction_status === 'pending' && now - new Date(d.created_at).getTime() < PENDING_STALE_MS) return 'reading';
  return 'manual';
}
// A PDF the reader decided isn't a rate con: shown as "Not a rate con · needs manual entry", not counted as waiting.
export const isNotRatecon = (d) => !!d && d.source === 'email' && !d.load_id && !d.ai_extracted_data && d.extraction_error === 'not_ratecon';
export const isEmailDraft = (d) => !!d && d.source === 'email' && !d.load_id && (!d.doc_type || d.doc_type === 'rate_confirmation') && !isNotRatecon(d) && !isHandledDoc(d);

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

// "Skipped from email" notices come from the company's inbound rate con emails (subject, attachment names).
// Only owner / management / dispatcher see them (drivers never), and only for the active company.
export const SKIPPED_ROLES = ['owner', 'management', 'dispatcher'];
export const canSeeSkipped = (role) => SKIPPED_ROLES.includes(role);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Scope: a row tagged with a company (company_id = company_profiles.id) belongs only to that company; an older,
// untagged row (company_id null) belongs to the company whose owner received it (owner_id).
// Untagged rows (pre-#127 webhook, company_id null) belong to whoever received them: the company owner OR this user
// (e.g. a dispatcher's own ratecon address). RLS still decides what the caller can read.
export function skippedRowInScope(row, { ownerId, companyId, userId = null } = {}) {
  if (!row) return false;
  if (row.company_id) return !!companyId && row.company_id === companyId;
  return (!!ownerId && row.owner_id === ownerId) || (!!userId && row.owner_id === userId);
}
export async function fetchSkipped(supabase, { role, ownerId, companyId = null, userId = null, now = Date.now() } = {}) {
  if (!canSeeSkipped(role) || !UUID_RE.test(ownerId || '')) return [];
  const cid = UUID_RE.test(companyId || '') ? companyId : null;
  const since = new Date(now - 7 * 864e5).toISOString();
  const uid = UUID_RE.test(userId || '') && userId !== ownerId ? userId : null;
  const untagged = `and(company_id.is.null,owner_id.eq.${ownerId})` + (uid ? `,and(company_id.is.null,owner_id.eq.${uid})` : '');
  const scope = cid ? `${untagged},company_id.eq.${cid}` : untagged;
  const { data, error } = await supabase.from('inbound_emails').select('id, owner_id, company_id, subject, received_at, rejected_attachments')
    .or(scope).eq('kind', 'ratecon').gte('received_at', since).order('received_at', { ascending: false }).limit(10);
  return error ? [] : (data || []).filter((r) => skippedRowInScope(r, { ownerId, companyId: cid, userId: uid }));
}

// Create load (Oct 22): an emailed rate con goes through create_load_from_email_document (any office member of the
// company; the load belongs to the company owner; a second tap returns the same load). Uploaded rate cons keep
// create_load_from_document. Before migration 20261022150000 the email RPC is missing → use the old one.
export const EMAIL_CREATE_RPC = 'create_load_from_email_document';
// Uploaded rate cons (Oct 22, 20261022250000): create_load_from_company_upload, so a dispatcher's / Management's own
// upload becomes a load of their company (before, it was a personal load: driver picker "Me" only, "Load not found.").
export const UPLOAD_CREATE_RPC = 'create_load_from_company_upload';
export const createLoadRpc = (doc) => (doc?.source === 'email' ? EMAIL_CREATE_RPC : UPLOAD_CREATE_RPC);
export const isMissingRpc = (error) => !!error && (error.code === 'PGRST202' || error.code === '42883');
// profileId (SQL review): the active company, passed to the upload RPC when the caller is its owner / Management /
// Dispatcher (the RPC rejects anything else); null → the RPC picks as before. Never sent to the other RPCs.
export const uploadProfileFor = (active) => (active?.profile_id && SKIPPED_ROLES.includes(active.role) ? active.profile_id : null);
export async function createLoadFromDoc(supabase, doc, tz, { profileId = null } = {}) {
  const args = { p_document: doc.id, p_tz: tz };
  const fn = createLoadRpc(doc);
  let r = await supabase.rpc(fn, fn === UPLOAD_CREATE_RPC && profileId ? { ...args, p_profile: profileId } : args);
  if (isMissingRpc(r.error)) r = await supabase.rpc('create_load_from_document', args);
  return r;
}
// A company email draft that landed on a teammate's address: shown (read + Create load) but delete / change type stay
// with the receiver (documents writes are own-rows).
export const teammateEmailDoc = (d, userId) => !!d && d.source === 'email' && !!d.user_id && !!userId && d.user_id !== userId;
