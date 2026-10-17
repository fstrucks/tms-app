import { checkValue } from './packetValues.js';
import { EXTRA_KEY_LABELS, SKIP_KEY, SKIP_LABEL, isCustomKey, customName, isUnnamedKey } from './packetFieldNames.js';
// Pure state helpers for the manual-mapping screen (unit-tested; no React).
export const KEY_LABELS = {
  legal_name: 'Legal name', dba_name: 'DBA name', mc_number: 'MC number', dot_number: 'USDOT number', address_line1: 'Address', address_line2: 'Address line 2',
  city: 'City', state: 'State', postal_code: 'ZIP', phone: 'Phone', email: 'Email', signer_name: 'Signer name', signer_title: 'Signer title',
  ein: 'EIN / TIN', bank_routing: 'Bank routing #', bank_account: 'Bank account #', signature: 'Signature', date: 'Date',
  ...EXTRA_KEY_LABELS,
};
// Display name for any stored key: profile / extra keys, "Custom (type a name)" names, or the skip option.
export function fieldName(key) {
  if (!key) return '';
  if (isCustomKey(key)) return customName(key);
  if (key === SKIP_KEY) return SKIP_LABEL;
  return KEY_LABELS[key] || '';
}
export const BANK = new Set(['bank_routing', 'bank_account']);
export const SENSITIVE = new Set(['bank_routing', 'bank_account', 'ein']);
export const NEW_BOX = [0, 0, 560, 36]; // px at 200 dpi (~2.8in × 0.18in)

export function fieldState(f) {
  if (isUnnamedKey(f.profile_key)) return 'unmapped';
  if (f.profile_key === SKIP_KEY) return 'skip'; // left blank on purpose: named, never filled
  if ((f.kind === 'signature' || f.profile_key === 'signature') && !f.signed) return 'sign';
  if (f.check && !f.check.ok && BANK.has(f.profile_key)) return 'check';
  if (BANK.has(f.profile_key) && !f.confirmed) return 'confirm';
  if (f.check && !f.check.ok) return 'check';
  return 'ok';
}
export const STATE_COLORS = { sign: '#7c3aed', unmapped: '#d97706', confirm: '#dc2626', check: '#b45309', ok: '#16a34a', skip: '#6b7280' };

export function summarize(fields) {
  const s = { total: fields.length, unmapped: 0, confirm: 0, check: 0, ok: 0, sign: 0, skip: 0 };
  for (const f of fields) s[fieldState(f)]++;
  return s;
}
// Tap point (page px) → new field box centred vertically on the tap, clamped to the page.
export function placeBox(x, y, pageW, pageH, [, , w, h] = NEW_BOX) {
  const ww = Math.min(w, pageW), x0 = Math.max(0, Math.min(x, pageW - ww)), y0 = Math.max(0, Math.min(y - h / 2, pageH - h));
  return [Math.round(x0), Math.round(y0), Math.round(x0 + ww), Math.round(y0 + h)];
}
export function nudge(box, dx, dy, dw, pageW, pageH) {
  let [x0, y0, x1, y1] = box; x1 = Math.max(x0 + 40, x1 + dw);
  const w = x1 - x0, h = y1 - y0;
  x0 = Math.max(0, Math.min(x0 + dx, pageW - w)); y0 = Math.max(0, Math.min(y0 + dy, pageH - h));
  return [x0, y0, x0 + w, y0 + h];
}
// Edits → PATCH body. Only changed props; value only if typed; confirm only if newly ticked.
export function buildPatch(fields, deleted) {
  const upserts = [];
  for (const f of fields) {
    if (!f.dirty) continue;
    const e = { page: f.page, kind: f.kind, label: f.label, box: f.box, profile_key: f.profile_key || null, page_w: f.page_w, page_h: f.page_h };
    if (f.id && !String(f.id).startsWith('tmp-')) e.id = f.id; else e.field_key = f.field_key;
    if (f.valueDirty) e.value = f.value;
    if (f.confirmDirty && f.confirmed) e.confirm = true;
    upserts.push(e);
  }
  return { upserts, deletes: deleted.filter((id) => !String(id).startsWith('tmp-')) };
}
export function updateField(f, patch) {
  const n = { ...f, ...patch, dirty: true };
  if ('value' in patch) { n.valueDirty = true; n.confirmed = false; }
  if ('profile_key' in patch && patch.profile_key !== f.profile_key) { n.confirmed = false; if (SENSITIVE.has(patch.profile_key) !== SENSITIVE.has(f.profile_key)) { n.value = ''; n.valueDirty = false; } }
  if ('confirmed' in patch) n.confirmDirty = true;
  if (n.profile_key === SKIP_KEY && 'profile_key' in patch && (n.value || n.has_value)) { n.value = ''; n.valueDirty = true; } // skipped fields are never filled
  n.needs_confirm = BANK.has(n.profile_key);
  // Re-run the format check on every value/name edit so the box colour follows what's typed.
  if ('value' in patch || 'profile_key' in patch) n.check = n.profile_key && !SENSITIVE.has(n.profile_key) && n.value ? checkValue(n.profile_key, n.value) : null;
  if (BANK.has(n.profile_key) && n.valueDirty && n.value) { const c = checkValue(n.profile_key, String(n.value).replace(/[\s-]/g, '')); n.check = c.ok ? null : c; }
  return n;
}
// Banner per manual_reason. Editors get the "how to fix" instruction; view-only users (drivers) can't
// add or name fields, so they get who can.
const WHO = 'the owner, dispatcher or management';
export const MANUAL_REASONS = {
  no_text_layer: 'This looks like a scanned packet (no text layer), so fields weren’t found automatically. Tap “Add field” to place them.',
  too_many_pages: 'Only the first pages were scanned for fields. Add any missing fields by hand.',
  read_failed: 'This PDF couldn’t be read automatically. Tap “Add field” to place fields by hand.',
  timeout: 'Field naming took too long, so fields are unnamed. Pick a name for each one.',
  reader_error: 'This PDF couldn’t be read or named automatically. Add fields or pick names by hand.',
  no_fields: 'No blank fields were found. Tap “Add field” to place them.',
};
export const MANUAL_REASONS_VIEW = {
  no_text_layer: `This packet was scanned, so fields need to be placed by ${WHO}.`,
  too_many_pages: `Only the first pages were scanned for fields. Any missing fields need to be added by ${WHO}.`,
  read_failed: `This PDF couldn’t be read automatically, so fields need to be placed by ${WHO}.`,
  timeout: `Field naming took too long, so fields still need names from ${WHO}.`,
  reader_error: `This PDF couldn’t be read or named automatically, so fields need to be set up by ${WHO}.`,
  no_fields: `No blank fields were found, so fields need to be placed by ${WHO}.`,
};
export function manualReasonText(reason, canEdit) {
  if (!reason) return null;
  return (canEdit ? MANUAL_REASONS : MANUAL_REASONS_VIEW)[reason] || (canEdit ? 'Fields need to be checked by hand.' : `Fields need to be set up by ${WHO}.`);
}


// Bank fields with a number (typed now or saved before) that aren't confirmed block Save.
export function unconfirmedBank(fields) {
  return fields.filter((f) => BANK.has(f.profile_key) && (f.value || f.has_value) && !f.confirmed);
}
