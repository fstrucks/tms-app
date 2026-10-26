// Load notes box on the load page (Taylor's QA of #153). Saved through the existing load edit path,
// dispatch_update_load (owner, management, dispatcher; drivers get not_allowed). No new SQL or policy.
import { saveLoad } from './dispatch';
import { isLoadOwnerView } from './visibleLoads';

export const LOAD_NOTES_MAX = 4000; // dispatch_update_load refuses longer text fields

export function canEditLoadNotes(load) {
  if (!load) return false;
  if (isLoadOwnerView(load)) return true;
  return ['management', 'dispatcher'].includes(load.viewer_role);
}

// → { ok: true, notes } | { ok: false, error }
export async function saveLoadNotes(supabase, loadId, text) {
  const notes = String(text ?? '').trim();
  if (notes.length > LOAD_NOTES_MAX) return { ok: false, error: `Notes can be up to ${LOAD_NOTES_MAX.toLocaleString('en-US')} characters.` };
  const r = await saveLoad(supabase, loadId, { notes: notes || null });
  if (!r.ok) return { ok: false, error: r.error || 'Couldn’t save the notes. Please try again.' };
  return { ok: true, notes: r.load && Object.prototype.hasOwnProperty.call(r.load, 'notes') ? r.load.notes : (notes || null) };
}
