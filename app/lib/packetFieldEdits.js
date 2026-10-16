// Server: validate/normalize manual-mapping edits, encrypt sensitive values, enforce bank confirmation.
import { PROFILE_KEYS } from './packetReader.js';
import { checkValue } from './packetValues.js';

export const SENSITIVE_KEYS = new Set(['bank_routing', 'bank_account', 'ein']);
export const KINDS = ['text', 'checkbox', 'signature', 'date'];
const MAX_FIELDS = 400;
const num = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : NaN;

export function mask(last4) { return last4 ? `•••${last4}` : ''; }

// Row (DB) → client shape. Never includes ciphertext.
export function toClient(r) {
  const sensitive = SENSITIVE_KEYS.has(r.profile_key);
  return {
    id: r.id, field_key: r.field_key, page: r.page, kind: r.kind, label: r.label || '', box: r.box, dpi: r.dpi,
    profile_key: r.profile_key, confidence: r.confidence, source: r.source, needs_confirm: r.needs_confirm,
    confirmed: !!r.confirmed_at, sensitive, has_value: sensitive ? !!r.value_ciphertext : r.value_text != null && r.value_text !== '',
    signed: !!r.signature_path, signer_name: r.signer_name || null, signed_at: r.signed_at || null,
    value: sensitive ? mask(r.value_last4) : (r.value_text ?? ''), check: sensitive ? null : (r.profile_key && r.value_text ? checkValue(r.profile_key, r.value_text) : null),
  };
}

// edit: { id?, field_key?, page, kind, label, box, profile_key, value?, confirm? }
// existing: DB row or null. Returns { row } or { error }.
export function applyEdit(edit, existing, { userId, encrypt, page = null, now = new Date().toISOString() }) {
  const pageNo = Math.trunc(Number(edit.page ?? existing?.page));
  if (!(pageNo >= 1 && pageNo <= 200)) return { error: 'Bad page' };
  const kind = edit.kind ?? existing?.kind;
  if (!KINDS.includes(kind)) return { error: 'Bad field type' };
  const box = (edit.box ?? existing?.box ?? []).map(num);
  if (box.length !== 4 || box.some(Number.isNaN) || box[2] <= box[0] || box[3] <= box[1] || box.some((v) => v < 0 || v > 20000)) return { error: 'Bad box' };
  let key = edit.profile_key === undefined ? existing?.profile_key ?? null : edit.profile_key || null;
  if (key && (!PROFILE_KEYS.includes(key) || key === 'unknown')) return { error: 'Unknown field name' };
  const row = {
    page: pageNo, kind, box, label: String(edit.label ?? existing?.label ?? '').slice(0, 200) || null, profile_key: key,
    needs_confirm: key === 'bank_routing' || key === 'bank_account', updated_by: userId, updated_at: now,
    source: existing && edit.box === undefined && edit.profile_key === undefined ? existing.source : 'user',
  };
  const keyChanged = existing && existing.profile_key !== key;
  const sensitive = SENSITIVE_KEYS.has(key);
  let valueChanged = false;
  if (edit.value !== undefined) {
    const v = String(edit.value ?? '').trim().slice(0, 500);
    if (sensitive) {
      if (v && !/^[•*]+\d{0,4}$/.test(v)) { // masked echo = unchanged
        const digits = v.replace(/[\s-]/g, '');
        const c = checkValue(key, key === 'ein' ? v : digits);
        if (!c.ok) return { error: c.message };
        row.value_ciphertext = encrypt(key === 'ein' ? v : digits); row.value_last4 = digits.replace(/\D/g, '').slice(-4) || null; row.value_text = null; valueChanged = true;
      } else if (!v) { row.value_ciphertext = null; row.value_last4 = null; row.value_text = null; valueChanged = true; }
    } else { row.value_text = v || null; row.value_ciphertext = null; row.value_last4 = null; valueChanged = true; }
  } else if (keyChanged && (SENSITIVE_KEYS.has(existing.profile_key) !== sensitive)) {
    row.value_text = null; row.value_ciphertext = null; row.value_last4 = null; valueChanged = true; // don't move a secret into plaintext or vice versa
  }
  // Bank confirmation: cleared whenever the value or name changes; set only by an explicit confirm with a value present.
  if (valueChanged || keyChanged || !row.needs_confirm) { row.confirmed_at = null; row.confirmed_by = null; }
  if (edit.confirm === true) {
    if (!row.needs_confirm) return { error: 'Only bank numbers need confirming' };
    const hasVal = row.value_ciphertext !== undefined ? !!row.value_ciphertext : !!existing?.value_ciphertext;
    if (!hasVal) return { error: 'Enter the bank number before confirming' };
    row.confirmed_at = now; row.confirmed_by = userId;
  }
  if (!existing) row.field_key = String(edit.field_key || `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).slice(0, 60);
  if (page) { row.page_w = page.w; row.page_h = page.h; }
  return { row };
}
export { MAX_FIELDS };
