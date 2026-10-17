// One user-facing status per packet, shared by the /packets list and the packet page so they always agree.
// The DB `status` column only tracks the pipeline (received → processing → review → sent / archived / error);
// what the user sees also depends on the packet's fields (none yet? unsigned signatures?) and filled/sent times.
export const PACKET_STATUS_LABELS = {
  received: 'Waiting to start',
  processing: 'Finding fields…',
  review: 'Ready to fill out',
  signed: 'Signed',
  sent: 'Sent to broker',
  archived: 'Archived',
  error: 'Needs attention',
};
export const packetStatusLabel = (status) => PACKET_STATUS_LABELS[status] || String(status || '');
export const isPendingStatus = (status) => status === 'received' || status === 'processing';

export const isSigFieldRow = (f) => f.kind === 'signature' || f.profile_key === 'signature';
// Same rule as the packet page's orange "N need a name" badge (packetMapperModel fieldState → 'unmapped').
export const isUnnamedField = (f) => !f.profile_key;
// Field rows (DB rows with signature_path, or client fields with `signed`) → the counts the status needs.
export function fieldSummary(fields = []) {
  const s = { fieldCount: 0, sigTotal: 0, sigSigned: 0, unnamed: 0 };
  for (const f of fields) {
    s.fieldCount++;
    if (isUnnamedField(f)) s.unnamed++;
    if (isSigFieldRow(f)) { s.sigTotal++; if (f.signed || f.signature_path) s.sigSigned++; }
  }
  return s;
}

// Display statuses: key → label + chip colour. Keys, not labels, drive filters and tests.
export const DISPLAY = {
  received: { label: PACKET_STATUS_LABELS.received, color: '#6b7280' },
  processing: { label: PACKET_STATUS_LABELS.processing, color: '#6b7280' },
  error: { label: PACKET_STATUS_LABELS.error, color: '#b91c1c' },
  needs_fields: { label: 'Needs fields', color: '#d97706' },
  needs_names: { label: 'Name fields', color: '#d97706' }, // amber, same as the badge; label gets the count: "Name 3 fields"
  needs_signature: { label: 'Needs signature', color: '#7c3aed' },
  ready: { label: PACKET_STATUS_LABELS.review, color: '#2563eb' },
  signed: { label: PACKET_STATUS_LABELS.signed, color: '#0f766e' },
  filled: { label: 'Filled', color: '#16a34a' },
  sent: { label: PACKET_STATUS_LABELS.sent, color: '#15803d' },
  archived: { label: PACKET_STATUS_LABELS.archived, color: '#4b5563' },
};
// packet: { status, filled_at, sent_at }; summary: fieldSummary(...) or null when unknown.
export function packetDisplayStatus(packet, summary) {
  const st = packet?.status;
  const key = (() => {
    if (st === 'archived') return 'archived';
    if (st === 'received' || st === 'processing' || st === 'error') return st;
    if (st === 'sent' || packet?.sent_at) return 'sent';
    if (!summary) return 'ready';
    if (summary.fieldCount === 0) return 'needs_fields';
    const unsigned = summary.sigTotal > summary.sigSigned;
    // Filled / Signed win over "Name N fields": once filled or fully signed, unnamed boxes don't block anything.
    if (!unsigned && packet?.filled_at) return 'filled';
    if (!unsigned && summary.sigTotal > 0) return 'signed';
    if (summary.unnamed > 0) return 'needs_names'; // still beats Needs signature / Ready to fill out
    if (unsigned) return 'needs_signature';
    return 'ready';
  })();
  if (key === 'needs_names') return { key, ...DISPLAY[key], label: namesLabel(summary.unnamed) };
  return { key, ...DISPLAY[key] };
}
export const namesLabel = (n) => `Name ${n} field${n === 1 ? '' : 's'}`;
// Chip style shared by the list rows and the packet page header.
export const statusChipStyle = (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#fff', background: color, whiteSpace: 'nowrap' });

// Scanned / unreadable packets with no fields: tell the user how to start.
const MANUAL_START = new Set(['no_text_layer', 'no_fields', 'read_failed', 'reader_error']);
export const ADD_FIELD_HINT = 'Tap “Add field”, then tap the page where each field goes.';
export const ADD_FIELD_HINT_VIEW = 'Fields need to be placed by the owner, dispatcher or management.';
export function addFieldHint(packet, summary, canEdit) {
  if (!summary || summary.fieldCount > 0) return null;
  if (packet?.status !== 'review' || !MANUAL_START.has(packet?.manual_reason)) return null;
  return canEdit ? ADD_FIELD_HINT : ADD_FIELD_HINT_VIEW;
}

// List filters (chips on /packets). Archived packets are hidden unless the Archived filter is picked.
export const PACKET_FILTERS = [
  { id: 'all', label: 'All', keys: null },
  { id: 'todo', label: 'To do', keys: ['received', 'processing', 'error', 'needs_fields', 'needs_names', 'needs_signature', 'ready'] },
  { id: 'filled', label: 'Filled', keys: ['filled', 'signed'] },
  { id: 'sent', label: 'Sent', keys: ['sent'] },
  { id: 'archived', label: 'Archived', keys: ['archived'] },
];
export function filterPackets(rows, filterId) {
  const f = PACKET_FILTERS.find((x) => x.id === filterId) || PACKET_FILTERS[0];
  return rows.filter((r) => (f.keys ? f.keys.includes(r.display) : r.display !== 'archived'));
}
export function filterCounts(rows) {
  const out = {};
  for (const f of PACKET_FILTERS) out[f.id] = filterPackets(rows, f.id).length;
  return out;
}

// Archive uses the existing status value 'archived' (already allowed by packets_status_check; no SQL).
// Unarchive puts back the pipeline status implied by the packet's own columns.
export function unarchivedStatus(p) {
  if (p.sent_at) return 'sent';
  if (p.processed_at) return p.process_error && !p.manual_reason ? 'error' : 'review';
  return 'received';
}
// Archive / unarchive / delete: owner and management only (same roles that can send to brokers).
export const MANAGE_ROLES = new Set(['owner', 'management']);
export const canManagePackets = (role) => MANAGE_ROLES.has(role);

// List polling: only while something is pending; backs off, pauses in background tabs, then stops.
export const POLL_MS = 2000;
export const POLL_MAX_TICKS = 90; // legacy cap (~3 min at 2s)
export const POLL_BACKOFF_MS = [2000, 3000, 5000, 8000, 10000];
export const POLL_MAX_MS = 3 * 60 * 1000;
export const pollDelay = (n) => POLL_BACKOFF_MS[Math.min(n, POLL_BACKOFF_MS.length - 1)];
