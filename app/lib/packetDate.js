// Client-safe. Dates print as MM/DD/YYYY in the user's time zone.
export function formatPacketDate(d = new Date(), tz = 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(d));
}
