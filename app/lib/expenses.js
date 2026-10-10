export const EXPENSE_CATEGORIES = ['fuel', 'tolls', 'maintenance', 'food', 'lodging', 'other'];

// Sum of expense amounts (numeric comes back as string or number).
export const sumAmounts = (rows) => (rows || []).reduce((t, r) => t + (Number(r.amount) || 0), 0);

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// expense_date is a plain date; format without timezone shifting.
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}
