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
// Edited props a save writes. Equal (box within rounding) = the server already has this edit.
const nearBox = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(Number(v) - Number(b[i])) <= 0.6);
export function sameAsServer(local, server) {
  if (!local || !server) return false;
  if (Number(local.page) !== Number(server.page)) return false;
  if ((local.kind ?? server.kind) !== server.kind) return false;
  if (String(local.label ?? '').trim() !== String(server.label ?? '').trim()) return false;
  if ((local.profile_key || null) !== (server.profile_key || null)) return false;
  if (!nearBox(local.box, server.box)) return false;
  if (local.valueDirty) {
    if (SENSITIVE.has(local.profile_key) || server.sensitive) return false; // masked on the server copy: can't compare, keep the edit
    if (String(local.value ?? '') !== String(server.value ?? '')) return false;
  }
  if (local.confirmDirty && local.confirmed && !server.confirmed) return false;
  return true;
}
const SIG_PROPS = ['signed', 'signer_name', 'signed_at'];
// Unsaved local edits + the server's current fields → what is really still unsaved (QA #78 a).
// A new field (tmp- id) whose field_key is already on the server was saved by a request whose reply got lost:
// it is merged onto that server row (never appended again, so no duplicate), and dropped when nothing differs.
// Edits the server already has and deletes of rows that are gone are dropped too.
export function reconcileWithServer(serverFields, dirtyFields = [], deleted = []) {
  const server = serverFields || [];
  const byId = new Map(server.map((f) => [String(f.id), f]));
  const byKey = new Map(server.filter((f) => f.field_key).map((f) => [f.field_key, f]));
  const edits = new Map(); const extra = []; const seenKeys = new Set();
  let pending = 0, alreadySaved = 0, secretsDropped = 0;
  for (const f of dirtyFields) {
    const tmp = String(f.id).startsWith('tmp-');
    if (tmp && f.field_key) { if (seenKeys.has(f.field_key)) continue; seenKeys.add(f.field_key); } // same new field twice
    const srv = tmp ? (f.field_key ? byKey.get(f.field_key) : null) : byId.get(String(f.id));
    if (!tmp && !srv) continue; // row removed on the server meanwhile: nothing to apply the edit to
    if (srv && sameAsServer(f, srv)) { alreadySaved++; continue; }
    if (srv) {
      const m = { ...srv, ...f, id: srv.id, field_key: srv.field_key, dirty: true };
      for (const k of SIG_PROPS) m[k] = srv[k];
      edits.set(String(srv.id), m);
      if (tmp) alreadySaved++; // the field itself exists; only some edits are newer
    } else extra.push(f);
    pending++; if (f.secretDropped) secretsDropped++;
  }
  const del = (deleted || []).map(String).filter((id) => byId.has(id));
  const delSet = new Set(del);
  const fields = server.filter((f) => !delSet.has(String(f.id))).map((f) => edits.get(String(f.id)) || f).concat(extra);
  return { fields, deleted: del, pending: pending + del.length, alreadySaved, secretsDropped };
}
// Server fields + draft → fields with the unsaved edits re-applied (new fields appended once; deleted removed).
// Reconciled against the server first, so a save that went through but never cleared the draft can't come back
// as "Restored N unsaved changes" or as a duplicate field.
export function applyDraft(serverFields, draft) {
  if (!draft) return { fields: serverFields, deleted: [], restored: 0, secretsDropped: 0 };
  const r = reconcileWithServer(serverFields, draft.fields || [], draft.deleted || []);
  return { fields: r.fields, deleted: r.deleted, restored: r.pending, secretsDropped: r.secretsDropped, alreadySaved: r.alreadySaved };
}
// Reply to "Save changes" that doesn't prove anything either way: no answer (status 0, connection dropped),
// a 5xx, or a 2xx without the field list. The save may have gone through, so check the server before saying so.
export const saveOutcomeUnknown = (r) => !r || r.status === 0 || r.status >= 500 || (!r.error && !Array.isArray(r.fields));
