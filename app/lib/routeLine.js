// Shared route-line helpers (Nov 28 2026): every stop in load-page order, for list rows and the
// Home Current load card. Pure: no React/DOM. Unit-tested in tests/js/allStopsLists.test.mjs
// (and re-exported from homeCurrentLoad.js for the existing homeAllStops tests).
import { sortedStops, pickupStop, deliveryStop } from './loadTabs.js';
import { fmtApptDate } from './stopAppt.js';

export const cityState = (stop) => [stop?.city, stop?.state].filter(Boolean).join(', ');

// City, state; else the facility name (trimmed); else '—'.
export const stopPlace = (stop) => cityState(stop) || (stop?.company_name || '').trim() || '—';

// One place per stop in sequence order, e.g. ['Lathrop, CA', 'Warrenton, OR', 'Hillsboro, OR'].
// No stops → ['—'].
export function routeStops(load) {
  const st = sortedStops(load);
  return st.length ? st.map(stopPlace) : ['—'];
}
export const routeStopsText = (load) => routeStops(load).join(' → ');

// List-row label for one stop: "City, ST · Nov 28" when the appointment date is known.
export function stopSummaryText(stop) {
  if (!stop) return '—';
  const date = fmtApptDate(stop.appointment_start, stop.timezone);
  return date ? `${stopPlace(stop)} · ${date}` : stopPlace(stop);
}

export const isShortListRoute = (load) => sortedStops(load).length <= 2;

// Places shown on a list / "On the road" / boards row.
// 0 stops → ['—']. 1–2 stops → first pickup and last delivery (same pair as today), with
// appointment dates when datesOnShort is true. 3+ stops → every stop in order, city/state only
// (a wrapping route line; dates would make phone rows too tall).
export function listRoutePlaces(load, { datesOnShort = false } = {}) {
  const st = sortedStops(load);
  if (st.length <= 2) {
    const a = pickupStop(load);
    const b = deliveryStop(load);
    if (!a && !b) return ['—'];
    const label = (s) => (datesOnShort ? stopSummaryText(s) : (s ? stopPlace(s) : '—'));
    return [label(a), label(b)];
  }
  return st.map(stopPlace);
}
export const listRouteText = (load, opts) => listRoutePlaces(load, opts).join(' → ');
