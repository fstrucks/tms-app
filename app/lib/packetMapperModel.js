// Pure state helpers for the manual-mapping screen (unit-tested; no React).
export const KEY_LABELS = {
  legal_name: 'Legal name', dba_name: 'DBA name', mc_number: 'MC number', dot_number: 'USDOT number', address_line1: 'Address', address_line2: 'Address line 2',
  city: 'City', state: 'State', postal_code: 'ZIP', phone: 'Phone', email: 'Email', signer_name: 'Signer name', signer_title: 'Signer title',
  ein: 'EIN / TIN', bank_routing: 'Bank routing #', bank_account: 'Bank account #', signature: 'Signature', date: 'Date',
};
export const BANK = new Set(['bank_routing', 'bank_account']);
export const SENSITIVE = new Set(['bank_routing', 'bank_account', 'ein']);
export const NEW_BOX = [0, 0, 560, 36]; // px at 200 dpi (~2.8in × 0.18in)

export function fieldState(f) {
  if (!f.profile_key) return 'unmapped';
  if (BANK.has(f.profile_key) && !f.confirmed) return 'confirm';
  if (f.check && !f.check.ok) return 'check';
  return 'ok';
}
export const STATE_COLORS = { unmapped: '#d97706', confirm: '#dc2626', check: '#b45309', ok: '#16a34a' };

export function summarize(fields) {
  const s = { total: fields.length, unmapped: 0, confirm: 0, check: 0, ok: 0 };
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
  n.needs_confirm = BANK.has(n.profile_key);
  return n;
}
export const MANUAL_REASONS = {
  no_text_layer: 'This looks like a scanned packet (no text layer), so fields weren’t found automatically. Tap “Add field” to place them.',
  too_many_pages: 'Only the first pages were scanned for fields. Add any missing fields by hand.',
  timeout: 'Field naming took too long, so fields are unnamed. Pick a name for each one.',
  reader_error: 'Automatic naming failed, so fields are unnamed. Pick a name for each one.',
  no_fields: 'No blank fields were found. Tap “Add field” to place them.',
};
