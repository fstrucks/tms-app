// Status-change helpers for app/loads/[id]. A load fetch that started before a status change
// finishes must not overwrite the newer status (it would show the old tag until reload).
export function mergeFetchedLoad(current, fetched, startedBeforeStatusChange) {
  if (!startedBeforeStatusChange || !current || current.id !== fetched.id) return fetched;
  return { ...fetched, status: current.status };
}
// Result of a save: keep the new status on success (prefer the row the DB returned), revert on error.
export function settleStatus(current, { error, saved, prev }) {
  if (!current) return current;
  if (error) return { ...current, status: prev };
  return saved?.status ? { ...current, status: saved.status } : current;
}
