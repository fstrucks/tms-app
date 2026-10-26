// Load-docs vault: which paperwork a person may see, and how search / paging slices it.
// Visibility matches the app today: your own rows, plus teammates' files only when they
// are linked to a load you can already open (rate cons follow "Show rate to driver").
import { canViewLoadDocs, visibleDocsFor } from './loadDocs';
import { isCompanyDocType, LOAD_PICTURE_TYPE } from './docTypes';
import { needsAttention } from './docsInbox';

export const LOAD_VAULT_PAGE = 20;
export const LOAD_VAULT_TYPES = ['rate_confirmation', 'bol', 'pod', 'lumper_receipt', 'scale_ticket', LOAD_PICTURE_TYPE];

export function isLoadVaultDoc(doc) {
  if (!doc) return false;
  const t = doc.doc_type;
  if (t == null || t === '') return true;
  if (t === 'receipt') return false;
  if (isCompanyDocType(t)) return false;
  if (String(t).startsWith('other:')) return true;
  return LOAD_VAULT_TYPES.includes(t);
}

export function escapeIlike(s) {
  return String(s || '').replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

export function chunks(list, size) {
  const out = [];
  for (let i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const DATE_RANGE_ERROR = 'From date must be on or before To date';

export function reversedDateRange(filters = {}) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(filters.from || '') ? filters.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(filters.to || '') ? filters.to : '';
  return !!(from && to && from > to);
}

export function normalizeFilters(filters = {}) {
  const load = String(filters.load || '').trim().slice(0, 80);
  const broker = String(filters.broker || '').trim().slice(0, 80);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(filters.from || '') ? filters.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(filters.to || '') ? filters.to : '';
  const type = String(filters.type || '');
  const allowed = new Set(['', 'all', 'other', ...LOAD_VAULT_TYPES]);
  return { load, broker, from, to, type: allowed.has(type) && type !== 'all' ? type : '' };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function matchesVaultFilters(doc, load, filters = {}) {
  const f = normalizeFilters(filters);
  if (reversedDateRange(f)) return false;
  if (f.type === 'other') {
    if (!String(doc?.doc_type || '').startsWith('other:')) return false;
  } else if (f.type && doc?.doc_type !== f.type) return false;
  const day = String(doc?.created_at || '').slice(0, 10);
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
  if (f.load) {
    const q = norm(f.load);
    const x = doc?.ai_extracted_data && typeof doc.ai_extracted_data === 'object' ? doc.ai_extracted_data : {};
    const nums = [load?.broker_load_number, x.load_number, ...(Array.isArray(x.reference_numbers) ? x.reference_numbers : [])];
    if (!nums.some((n) => norm(n).includes(q))) return false;
  }
  if (f.broker) {
    const q = f.broker.toLowerCase();
    const x = doc?.ai_extracted_data && typeof doc.ai_extracted_data === 'object' ? doc.ai_extracted_data : {};
    const hay = `${load?.broker_name || ''} ${x.broker_name || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// Own paperwork is always yours. A teammate's file is visible only on a company load you can open.
export function canSeeVaultDoc({ role, userId, ownerId, doc, load }) {
  if (!isLoadVaultDoc(doc)) return false;
  if (load && ownerId && load.user_id && load.user_id !== ownerId) return doc.user_id === userId;
  if (doc.user_id === userId) return true;
  if (!load) return false;
  if (!canViewLoadDocs(role, load, userId)) return false;
  return visibleDocsFor(role, load, userId, [doc]).length > 0;
}

// Team list (Docs → Team, and the load page): linked files only. Unlinked uploads stay with their uploader.
export function canSeeTeamDoc({ role, userId, ownerId, doc, load }) {
  if (!isLoadVaultDoc(doc)) return false;
  if (!load || (ownerId && load.user_id && load.user_id !== ownerId)) return false;
  if (!canViewLoadDocs(role, load, userId)) return false;
  return visibleDocsFor(role, load, userId, [doc]).length > 0;
}

export function parseCursor(s) {
  if (!s || typeof s !== 'string') return null;
  const i = s.lastIndexOf('|');
  if (i <= 0) return null;
  const created_at = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!created_at || !id || created_at.length > 40 || id.length > 80) return null;
  return { created_at, id };
}

export function cursorOf(doc) {
  return `${doc.created_at}|${doc.id}`;
}

export function isOlderThan(doc, cursor) {
  if (!cursor) return true;
  const a = String(doc?.created_at || '');
  if (a < cursor.created_at) return true;
  if (a > cursor.created_at) return false;
  return String(doc?.id || '') < String(cursor.id || '');
}

export function cmpDesc(a, b) {
  const c = String(b?.created_at || '').localeCompare(String(a?.created_at || ''));
  if (c) return c;
  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

export function pageLoadVault({ docs, loads, ticketLoads, role, userId, ownerId, filters = {}, cursor = null, limit = LOAD_VAULT_PAGE } = {}) {
  const loadsById = new Map((loads || []).filter((l) => l?.id).map((l) => [l.id, l]));
  const ticket = new Map();
  for (const t of ticketLoads || []) if (t?.document_id && !ticket.has(t.document_id)) ticket.set(t.document_id, t);
  const cur = typeof cursor === 'string' ? parseCursor(cursor) : cursor;
  const seen = new Set();
  const rows = [];
  for (const doc of docs || []) {
    if (!doc?.id || seen.has(doc.id)) continue;
    seen.add(doc.id);
    const link = ticket.get(doc.id) || null;
    // Same predicate as Needs attention. Unhandled files stay out of this vault.
    if (needsAttention(doc, link)) continue;
    const loadId = doc.load_id || link?.load_id || null;
    const raw = loadId ? loadsById.get(loadId) || null : null;
    const load = raw && ownerId && raw.user_id && raw.user_id !== ownerId ? null : raw;
    if (!canSeeVaultDoc({ role, userId, ownerId, doc, load })) continue;
    if (!matchesVaultFilters(doc, load, filters)) continue;
    if (!isOlderThan(doc, cur)) continue;
    rows.push({ doc, load });
  }
  rows.sort((a, b) => cmpDesc(a.doc, b.doc));
  const page = rows.slice(0, limit);
  return {
    rows: page,
    nextCursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1].doc) : null,
  };
}
