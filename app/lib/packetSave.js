// "Save changes" on the packet field editor, without false errors or duplicate fields (QA #78 a).
// A reply that proves nothing (connection dropped = status 0, 5xx, or 2xx without the field list) is checked
// against the server before anything is shown: if the server already has every edit, it was saved.
// Otherwise the local edits are rebased onto what the server has (a new field that did get inserted keeps its
// server id), so tapping Save again updates that row instead of adding a second one.
import { reconcileWithServer, saveOutcomeUnknown } from './packetDraft.js';

export const SAVE_CHECK_DELAYS_MS = [800, 2500]; // a dropped reply can arrive before the server finishes writing
export const NOT_SAVED_SUFFIX = ' Your changes are still here; tap Save changes to try again.';

// → { kind: 'saved' | 'error' | 'signedOut', res, fields?, deleted?, pending? }
//   saved: fields = server copy (use as the new base), draft can be cleared.
//   error: fields/deleted (when present) = local edits rebased onto the server copy; keep the draft.
export async function saveFields({ save, reload, patch, dirty, deleted = [], sleep = (t) => new Promise((ok) => setTimeout(ok, t)), delaysMs = SAVE_CHECK_DELAYS_MS }) {
  const res = await save(patch);
  if (res?.signedOut) return { kind: 'signedOut', res };
  if (!saveOutcomeUnknown(res)) {
    if (res?.error) return { kind: 'error', res };
    return { kind: 'saved', res, fields: res.fields };
  }
  if (!reload) return { kind: 'error', res };
  let last = null;
  for (const ms of delaysMs) {
    await sleep(ms);
    const d = await reload().catch(() => null);
    if (d?.signedOut) return { kind: 'signedOut', res: d };
    if (!Array.isArray(d?.fields)) continue;
    const rec = reconcileWithServer(d.fields, dirty, deleted);
    last = { server: d.fields, ...rec };
    if (!rec.pending) return { kind: 'saved', res: { ...(res || {}), error: undefined, ok: true, fields: d.fields }, fields: d.fields, verified: true };
  }
  return last
    ? { kind: 'error', res, fields: last.fields, deleted: last.deleted, server: last.server, pending: last.pending }
    : { kind: 'error', res };
}
// Shown only when the server really doesn't have the edits.
export function saveErrorText(res) {
  if (!res || res.status === 0) return `Network problem: not saved.${NOT_SAVED_SUFFIX}`;
  if (res.status >= 500 && !res.error) return `Not saved.${NOT_SAVED_SUFFIX}`;
  return res.error || `Not saved.${NOT_SAVED_SUFFIX}`;
}
