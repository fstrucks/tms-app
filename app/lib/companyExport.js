// Company export before delete (PR E1): the pure planner. No network, no database.
// E2 (server step runner) and E3 (link page + email) build on these helpers.
// Decisions (Marc via Sam, Oct 28 2026): owner only; deletion confirm auto-starts an export; the emailed link
// needs no sign-in (so it never cancels deletion) and only sha256(token) is stored; link and ZIP parts live
// 7 days after purge; inbound rate con emails are metadata only; facility notes/reviews only where the
// author is in the company; export emails do not count toward the monthly send cap.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const EXPORT_BUCKET = 'company-exports';
export const PART_MAX_BYTES = 45 * 1024 * 1024; // part size, kept under the bucket limit; raise later together with the bucket (Free plan upload limit is 50 MB)
export const BUCKET_FILE_SIZE_LIMIT = 50 * 1024 * 1024; // must match the migration (52428800)
export const LINK_DAYS_AFTER_PURGE = 7;
export const LINK_DAYS_NO_PURGE = 7;
export const TOKEN_BYTES = 32;
export const COUNTS_TOWARD_SEND_CAP = false;
const DAY_MS = 24 * 60 * 60 * 1000;

// How a table's rows are tied to the company:
//   'owner'    rows whose user_id/owner_id is the owner
//   'members'  rows whose user_id is the owner or a member (the docInCompany rule)
//   'company'  rows whose company_profile_id is the company
//   'author'   shared-directory rows, only where the author is in the company
// columns: null = all columns; an array = only these (metadata-only tables).
export const EXPORT_TABLES = [
  { table: 'company_profiles', scope: 'company', key: 'id', file: 'company' },
  { table: 'company_members', scope: 'company', key: 'company_profile_id', file: 'members', columns: ['user_id', 'role', 'created_at'] },
  { table: 'former_members', scope: 'company', key: 'company_profile_id', file: 'former_members', needs: 'PR 161' },
  { table: 'loads', scope: 'members', key: 'user_id', file: 'loads' },
  { table: 'stops', scope: 'load', key: 'load_id', file: 'stops' },
  { table: 'stop_delays', scope: 'load', key: 'load_id', file: 'stop_delays' },
  { table: 'documents', scope: 'members', key: 'user_id', file: 'documents', hasFiles: true },
  { table: 'scale_tickets', scope: 'members', key: 'user_id', file: 'scale_tickets' },
  { table: 'invoices', scope: 'members', key: 'user_id', file: 'invoices' },
  { table: 'invoice_events', scope: 'invoice', key: 'invoice_id', file: 'invoice_events' },
  { table: 'expenses', scope: 'members', key: 'user_id', file: 'expenses' },
  { table: 'mileage_entries', scope: 'members', key: 'user_id', file: 'mileage' },
  { table: 'trucks', scope: 'members', key: 'user_id', file: 'trucks' },
  { table: 'trailers', scope: 'members', key: 'user_id', file: 'trailers' },
  { table: 'service_records', scope: 'owner', key: 'user_id', file: 'maintenance_service_records' },
  { table: 'service_record_items', scope: 'service_record', key: 'service_record_id', file: 'maintenance_service_items' },
  { table: 'pm_schedules', scope: 'owner', key: 'user_id', file: 'maintenance_pm_schedules' },
  { table: 'maintenance_interval_templates', scope: 'owner', key: 'user_id', file: 'maintenance_interval_templates' },
  { table: 'drivers', scope: 'owner', key: 'user_id', file: 'drivers', sensitive: true },
  { table: 'insurance_policies', scope: 'owner', key: 'user_id', file: 'insurance_policies' },
  { table: 'insurance_agents', scope: 'owner', key: 'user_id', file: 'insurance_agents' },
  { table: 'coi_requests', scope: 'owner', key: 'user_id', file: 'coi_requests' },
  { table: 'brokers', scope: 'owner', key: 'user_id', file: 'brokers' },
  { table: 'factors', scope: 'owner', key: 'user_id', file: 'factors' },
  { table: 'packets', scope: 'owner', key: 'owner_id', file: 'packets', hasFiles: true },
  { table: 'packet_fields', scope: 'packet', key: 'packet_id', file: 'packet_fields' },
  { table: 'packet_layouts', scope: 'packet', key: 'packet_id', file: 'packet_layouts' },
  { table: 'packet_sends', scope: 'owner', key: 'user_id', file: 'packet_sends' },
  { table: 'load_packet_sends', scope: 'load', key: 'load_id', file: 'load_packet_sends' },
  { table: 'company_checklist_status', scope: 'owner', key: 'user_id', file: 'checklist' },
  { table: 'compliance_reminders_state', scope: 'owner', key: 'user_id', file: 'compliance_reminders' },
  { table: 'inbound_emails', scope: 'owner', key: 'user_id', file: 'inbound_emails', columns: ['id', 'from_email', 'subject', 'received_at', 'status'] },
  { table: 'facility_notes', scope: 'author', key: 'user_id', file: 'facility_notes' },
  { table: 'facility_reviews', scope: 'author', key: 'user_id', file: 'facility_reviews' },
];

// Deliberately not exported, each with the reason (a guard test keeps this list and EXPORT_TABLES complete).
export const EXCLUDED_TABLES = {
  facilities: 'shared directory; names appear on loads and stops',
  facility_note_reports: 'moderation, internal',
  facility_review_reports: 'moderation, internal',
  ratecon_inbound_addresses: 'app routing setting',
  extraction_runs: 'internal reading log',
  eld_import_mappings: 'import setting',
  bug_reports: 'not a business record',
  account_deletion_requests: 'internal',
  account_deletion_storage_jobs: 'internal',
  export_jobs: 'internal',
  export_link_events: 'internal',
};

// Column-limited tables are metadata only. Unknown columns are left out by E2, never added.
export function pickColumns(spec, row) {
  if (!spec.columns) return { ...row };
  const out = {};
  for (const c of spec.columns) if (c in row) out[c] = row[c];
  return out;
}

export const DRUG_ALCOHOL_TYPES = ['drug_test', 'preemployment_drug', 'clearinghouse_queries', 'clearinghouse', 'da_consortium', 'da_policy'];
export const DRIVER_FILE_TYPES = ['cdl', 'medical_card', 'mvr', 'prehire_mvr', 'annual_mvr'];

const safe = (s, fallback = 'item') => {
  const t = String(s ?? '').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim().slice(0, 80);
  return t && t !== '.' && t !== '..' ? t : fallback;
};
const ext = (p) => { const m = /\.([a-z0-9]{1,5})$/i.exec(String(p || '')); return m ? '.' + m[1].toLowerCase() : ''; };

// Folder inside the ZIP for a document row. ctx: { loadNumber, driverName, unitName }.
export function folderFor(doc, ctx = {}) {
  const t = doc?.doc_type || 'other';
  if (DRUG_ALCOHOL_TYPES.includes(t)) return ctx.driverName ? `drivers/${safe(ctx.driverName)}/drug-alcohol` : 'drug-alcohol';
  if (DRIVER_FILE_TYPES.includes(t) || ctx.driverName) return `drivers/${safe(ctx.driverName, 'unassigned')}`;
  if (t === 'receipt') return `receipts/${String(doc.created_at || '').slice(0, 7) || 'undated'}`;
  if (t === 'invoice') return 'invoices';
  if (ctx.unitName || t === 'maintenance' || t === 'inspection') return `maintenance/${safe(ctx.unitName, 'general')}`;
  if (doc.load_id) return `loads/${safe(ctx.loadNumber, String(doc.load_id).slice(0, 8))}`;
  return `documents/${safe(t)}`;
}

export const isSensitivePath = (zipPath) => /^(drivers|drug-alcohol)\//.test(zipPath);

// Unique ZIP paths. Same name in one folder gets " (2)", " (3)", …
export function zipPaths(entries) {
  const seen = new Set();
  return entries.map((e) => {
    const folder = e.folder.replace(/\/+$/, '');
    const base = safe(String(e.name || '').split('/').pop().replace(/\.[^.]*$/, ''), 'file');
    const x = ext(e.name) || ext(e.file_path);
    let p = `${folder}/${base}${x}`;
    for (let n = 2; seen.has(p.toLowerCase()); n++) p = `${folder}/${base} (${n})${x}`;
    seen.add(p.toLowerCase());
    return { ...e, zipPath: p };
  });
}

// Split files (with known bytes) into parts no bigger than maxBytes (data files go in part 1).
// A single file larger than maxBytes gets its own part and is flagged (the bucket's 10 MB file limit makes this unlikely).
export function splitParts(files, { maxBytes = PART_MAX_BYTES, reserve = 0 } = {}) {
  const parts = [];
  let cur = { n: 1, files: [], bytes: reserve };
  for (const f of files) {
    const b = Math.max(0, Number(f.bytes) || 0);
    if (cur.files.length && cur.bytes + b > maxBytes) { parts.push(cur); cur = { n: parts.length + 1, files: [], bytes: 0 }; }
    cur.files.push(f); cur.bytes += b;
    if (b > maxBytes) cur.oversize = true;
  }
  if (cur.files.length || !parts.length) parts.push(cur);
  return parts;
}

export function partName(company, date, n, total) {
  const d = new Date(date).toISOString().slice(0, 10);
  return `PowerHaul-export-${safe(company, 'company').replace(/ /g, '-')}-${d}-part${n}of${total}.zip`;
}

export const partObject = (jobId, n) => `exports/${jobId}/part-${n}.zip`;

export const MANIFEST_COLUMNS = ['part', 'zip_path', 'bytes', 'sha256', 'source_table', 'source_id', 'status'];

export function manifestRow(f, part, status = 'ok') {
  return { part, zip_path: f.zipPath, bytes: Number(f.bytes) || 0, sha256: f.sha256 || '', source_table: f.table || 'documents', source_id: String(f.id ?? ''), status };
}

export function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula-injection guard for spreadsheets.
  const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return '\uFEFF' + [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// Full plan for E2: data files, document files, parts, manifest columns.
export function planExport({ jobId, companyName, at = new Date(), documents = [], ctxFor = () => ({}), dataBytes = 0, maxBytes = PART_MAX_BYTES }) {
  const entries = zipPaths(documents.map((d) => ({
    id: d.id, table: d.table || 'documents', file_path: d.file_path, bytes: d.bytes, name: d.original_filename || d.file_path?.split('/').pop() || 'file',
    folder: folderFor(d, ctxFor(d)),
  })));
  const parts = splitParts(entries, { maxBytes, reserve: dataBytes });
  const total = parts.length;
  return {
    tables: EXPORT_TABLES.map((t) => ({ table: t.table, zipPath: `data/${t.file}.csv`, json: `data/${t.file}.json`, metadataOnly: !!t.columns, sensitive: !!t.sensitive })),
    parts: parts.map((p) => ({ n: p.n, name: partName(companyName, at, p.n, total), object: partObject(jobId, p.n), bytes: p.bytes, oversize: !!p.oversize, files: p.files })),
    manifestColumns: MANIFEST_COLUMNS,
    sensitiveFiles: entries.filter((e) => isSensitivePath(e.zipPath)).length,
  };
}

// Owner-only guard. Server code passes the signed-in user and the company row it loaded itself.
export function canExport(user, company) {
  if (!user?.id || !company?.id || !company.owner_id) return { ok: false, status: user?.id ? 403 : 401, error: user?.id ? 'Only the company owner can export company records.' : 'Sign in first.' };
  if (company.owner_id !== user.id) return { ok: false, status: 403, error: 'Only the company owner can export company records.' };
  return { ok: true };
}

// Link tokens: base64url random, only the hex sha256 is stored.
export function newLinkToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}
export const hashToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');
export function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[0-9a-f]{64}$/.test(storedHash || '')) return false;
  return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

// Expiry: 7 days after purge if a deletion is scheduled, otherwise 7 days after the export is ready.
export function exportExpiresAt({ purgeAt = null, readyAt = new Date() } = {}) {
  const base = purgeAt ? Date.parse(purgeAt) : Date.parse(readyAt);
  if (!Number.isFinite(base)) return null;
  return new Date(base + (purgeAt ? LINK_DAYS_AFTER_PURGE : LINK_DAYS_NO_PURGE) * DAY_MS).toISOString();
}

// What the link page and cleanup do with a job right now.
export function linkState(job, now = new Date()) {
  if (!job) return 'missing';
  if (job.cleaned_at || job.status === 'expired') return 'expired';
  if (job.expires_at && Date.parse(job.expires_at) <= +now) return 'expired';
  if (job.status === 'ready') return 'ready';
  if (job.status === 'failed') return 'failed';
  return 'preparing';
}
export const needsCleanup = (job, now = new Date()) => !job?.cleaned_at && !!job?.expires_at && Date.parse(job.expires_at) <= +now;

// Which user_ids are "this company" (same rule as docInCompany: owner plus company_members).
// A member who also belongs to / owns another company is "shared": their user_id rows can't be
// attributed by user_id alone, so E2 only includes them when tied to this owner's load.
export function companyUserIds({ companyId, ownerId, members = [], allMemberships = [], owned = [] }) {
  const ids = [ownerId, ...members.filter((m) => m.company_profile_id === companyId).map((m) => m.user_id)].filter(Boolean);
  const uniq = [...new Set(ids)];
  const elsewhere = new Set([
    ...allMemberships.filter((m) => m.company_profile_id !== companyId).map((m) => m.user_id),
    ...owned.filter((c) => c.id !== companyId).map((c) => c.owner_id),
  ]);
  const shared = uniq.filter((u) => u !== ownerId && elsewhere.has(u));
  return { ids: uniq, exclusive: uniq.filter((u) => !shared.includes(u)), shared };
}

// Include a user_id-owned row? Exclusive users: yes. Shared members: only when the row's load is this owner's.
export function rowBelongs(row, { exclusive = [], shared = [], ownerId } = {}, { loadOwner } = {}) {
  const u = row?.user_id;
  if (!u) return false;
  if (exclusive.includes(u)) return true;
  return shared.includes(u) && !!ownerId && loadOwner === ownerId;
}
