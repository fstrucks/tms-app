// Client: keep unsaved mapping edits in sessionStorage so a sign-out (or reload) mid-edit loses nothing.
// Typed bank/EIN numbers are NOT stored (never put secrets in browser storage); those need re-typing.
import { SENSITIVE } from './packetMapperModel.js';
export const draftKey = (packetId) => `packet-draft:${packetId}`;

export function makeDraft(fields, deleted) {
  const dirty = fields.filter((f) => f.dirty).map((f) => {
    const d = { ...f };
    if (SENSITIVE.has(f.profile_key) && f.valueDirty) { d.value = ''; d.valueDirty = false; d.secretDropped = true; }
    delete d.check;
    return d;
  });
  return dirty.length || deleted.length ? { v: 1, at: Date.now(), fields: dirty, deleted } : null;
}
export function saveDraft(storage, packetId, fields, deleted) {
  try { const d = makeDraft(fields, deleted); if (d) storage.setItem(draftKey(packetId), JSON.stringify(d)); else storage.removeItem(draftKey(packetId)); } catch { /* storage full/blocked */ }
}
export function loadDraft(storage, packetId, maxAgeMs = 12 * 3600e3) {
  try { const d = JSON.parse(storage.getItem(draftKey(packetId)) || 'null'); return d?.v === 1 && Date.now() - d.at < maxAgeMs ? d : null; } catch { return null; }
}
export const clearDraft = (storage, packetId) => { try { storage.removeItem(draftKey(packetId)); } catch { /* */ } };
// Server fields + draft → fields with the unsaved edits re-applied (new tmp fields appended; deleted removed).
export function applyDraft(serverFields, draft) {
  if (!draft) return { fields: serverFields, deleted: [], restored: 0, secretsDropped: 0 };
  const byId = new Map(draft.fields.map((f) => [f.id, f]));
  const del = new Set(draft.deleted || []);
  const out = serverFields.filter((f) => !del.has(f.id)).map((f) => byId.get(f.id) || f);
  for (const f of draft.fields) if (String(f.id).startsWith('tmp-')) out.push(f);
  return { fields: out, deleted: [...del], restored: draft.fields.length + del.size, secretsDropped: draft.fields.filter((f) => f.secretDropped).length };
}
