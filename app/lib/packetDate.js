// Client-safe. Dates print as MM/DD/YYYY in the user's time zone.
export function formatPacketDate(d = new Date(), tz = 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(d));
}

// Date + time + zone label in the viewer's own zone (tz undefined = the browser's zone), e.g.
// "10/17/2026, 6:34 AM PDT". Accepts ISO strings with or without an offset; a bare "YYYY-MM-DD HH:MM:SS"
// (no zone) is treated as UTC, which is how Postgres timestamps come back when the zone is dropped.
export function parseUtc(d) {
  if (d instanceof Date) return d;
  const s = String(d || '');
  return new Date(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}
export function formatSentAt(d, tz) {
  const t = parseUtc(d);
  if (Number.isNaN(t.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(t);
}
// Shorter form for the /packets list: "Oct 17, 2026, 11:50 AM CDT" (viewer's zone, with its label).
export function formatListTime(d, tz) {
  const t = parseUtc(d);
  if (Number.isNaN(t.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(t);
}
