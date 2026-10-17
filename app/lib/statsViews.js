// Stats views. Mileage moved inside Stats (Marc, Oct 17). /mileage → /dashboard?view=mileage (query kept).
export const MILEAGE_VIEW_URL = '/dashboard?view=mileage';
export function mileageRedirectUrl(searchParams = {}) {
  const q = new URLSearchParams({ view: 'mileage' });
  for (const [k, v] of Object.entries(searchParams || {})) if (k !== 'view' && v != null) q.set(k, Array.isArray(v) ? v[0] : String(v));
  return `/dashboard?${q}`;
}
