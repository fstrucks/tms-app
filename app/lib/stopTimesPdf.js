// "Stop times" sheet (Oct 22): one Letter page per load listing each stop, its address, appointment and the actual
// time it was picked up / delivered (stops.completed_at), shown in the stop's own time zone. A record for detention
// claims; it goes with the invoice packet only when the user ticks the box. Standard fonts only (WinAnsi).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { plain } from './invoicePdf.js';
import { minutesOnSite, fmtDuration } from './stopProgress.js';
import { delayReasonLabel, delaysForStop, delayMinutes } from './stopDelays.js';
// Same format as fullAddress in loads.js (that module has JSX, so it can't load on the server here).
const fullAddress = (st) => [st?.address_line1, st?.address_line2, [[st?.city, st?.state].filter(Boolean).join(', '), st?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

export const DEFAULT_TZ = 'America/Chicago';
const validTz = (tz) => { try { if (!tz) return null; new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; } };
// JS mirror of public.us_state_tz (migration 20261010000660): main zone per US state.
const Z = { C: 'America/Chicago', E: 'America/New_York', M: 'America/Denver', P: 'America/Los_Angeles' };
const STATE_TZ = { AL: Z.C, AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: Z.C, CA: Z.P, CO: Z.M, CT: Z.E, DE: Z.E, DC: Z.E, FL: Z.E, GA: Z.E,
  HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: Z.C, IN: 'America/Indiana/Indianapolis', IA: Z.C, KS: Z.C, KY: Z.E, LA: Z.C, ME: Z.E, MD: Z.E,
  MA: Z.E, MI: 'America/Detroit', MN: Z.C, MS: Z.C, MO: Z.C, MT: Z.M, NE: Z.C, NV: Z.P, NH: Z.E, NJ: Z.E, NM: Z.M, NY: Z.E, NC: Z.E, ND: Z.C, OH: Z.E,
  OK: Z.C, OR: Z.P, PA: Z.E, RI: Z.E, SC: Z.E, SD: Z.C, TN: Z.C, TX: Z.C, UT: Z.M, VT: Z.E, VA: Z.E, WA: Z.P, WV: Z.E, WI: Z.C, WY: Z.M, PR: 'America/Puerto_Rico' };
export const stateTz = (st) => STATE_TZ[String(st || '').trim().toUpperCase()] || null;
// A stop's zone: its own timezone (set from its state when created from a rate con), else its state's zone,
// else the viewer's device zone, else Central. (Before: a stop with no timezone, e.g. no appointment, used the viewer's zone.)
// One zone for a whole packet (Taylor's QA of #153): the viewer's browser zone if it is a known IANA zone,
// else the company's zone setting (if the profile has one), else America/Chicago.
export const packetZone = (tz, company = null) => validTz(tz) || validTz(company?.timezone) || DEFAULT_TZ;
export const zoneAbbr = (tz, at = new Date()) => new Intl.DateTimeFormat('en-US', { timeZone: validTz(tz) || DEFAULT_TZ, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || '';
export const stopZone = (s, tz) => validTz(s?.timezone) || stateTz(s?.state) || validTz(tz) || DEFAULT_TZ;
export function fmtStopTime(iso, tz) {
  if (!iso || !isFinite(Date.parse(iso))) return null;
  return new Date(iso).toLocaleString('en-US', { timeZone: validTz(tz) || DEFAULT_TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
const TYPE = { pickup: 'Pickup', delivery: 'Delivery' };
const ACTUAL = { pickup: 'Picked up', delivery: 'Delivered' };

// load: { broker_load_number, broker_name, stops[] } → rows for the sheet (pure, for tests and the PDF).
// delays: stop_delays rows for the load (optional). Arrived shows once stops carry arrived_at (20261022170000).
export function stopTimeRows(load, { tz = null, delays = [], oneZone = false } = {}) {
  const withArrival = (load?.stops || []).length > 0 && (load.stops || []).every((x) => Object.prototype.hasOwnProperty.call(x, 'arrived_at'));
  return [...(load?.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((s, i) => {
    const zone = oneZone ? packetZone(tz) : stopZone(s, tz);
    const appt = s.appointment_start ? [fmtStopTime(s.appointment_start, zone), s.appointment_end ? fmtStopTime(s.appointment_end, zone) : null].filter(Boolean).join(' to ') : null;
    const actual = s.completion === 'skipped' ? 'Skipped' : s.completed_at ? fmtStopTime(s.completed_at, zone) : 'Not recorded';
    return { n: i + 1, type: TYPE[s.stop_type] || 'Stop', name: s.company_name || '', address: fullAddress(s), appointment: appt,
      actualLabel: ACTUAL[s.stop_type] || 'Completed', actual, recorded: !!s.completed_at && s.completion !== 'skipped',
      arrived: withArrival ? (s.arrived_at ? fmtStopTime(s.arrived_at, zone) : 'Not recorded') : null, arrivedRecorded: !!s.arrived_at,
      onSite: fmtDuration(minutesOnSite(s)),
      delays: delaysForStop(delays, s.id).map((d) => ({ reason: delayReasonLabel(d.reason), note: d.note || null,
        from: fmtStopTime(d.started_at, zone), to: d.ended_at ? fmtStopTime(d.ended_at, zone) : 'not ended', length: fmtDuration(delayMinutes(d)) })) };
  });
}
export const stopTimesFileName = (load) => `${String(load?.broker_load_number || 'Load').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'Load'}_StopTimes.pdf`;

export async function stopTimesPdf(load, company = null, { tz = null, generatedAt = new Date(), delays = [], oneZone = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.4, 0.4, 0.45), rule = rgb(0.8, 0.8, 0.82);
  const M = 48;
  let page = doc.addPage([612, 792]), y = 744;
  const text = (t, x, yy, { f = font, size = 10, color = ink } = {}) => page.drawText(plain(t).slice(0, 110), { x, y: yy, size, font: f, color });
  const carrier = company?.legal_name || company?.dba_name || '';
  text('Stop times', M, y, { f: bold, size: 20 }); y -= 22;
  text([carrier, load?.broker_load_number ? `Load ${load.broker_load_number}` : null, load?.broker_name ? `Broker: ${load.broker_name}` : null].filter(Boolean).join('   |   '), M, y, { color: muted }); y -= 14;
  text(`Actual arrival-to-completion record as checked off by the driver. Prepared ${fmtStopTime(generatedAt.toISOString(), tz)}.`, M, y, { size: 9, color: muted }); y -= 14;
  if (oneZone) { text(`All times in ${zoneAbbr(tz, generatedAt)} (${packetZone(tz)}).`, M, y, { size: 9, color: muted }); y -= 14; }
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: 612 - M, y }, thickness: 1, color: rule }); y -= 20;
  const rows = stopTimeRows(load, { tz, delays, oneZone });
  if (!rows.length) text('No stops on this load.', M, y, { color: muted });
  for (const r of rows) {
    if (y < 110) { page = doc.addPage([612, 792]); y = 744; }
    text(`${r.n}. ${r.type}${r.name ? ` - ${r.name}` : ''}`, M, y, { f: bold, size: 12 }); y -= 15;
    if (r.address) { text(r.address, M + 14, y); y -= 13; }
    if (r.appointment) { text(`Appointment: ${r.appointment}`, M + 14, y, { color: muted }); y -= 13; }
    const field = (k, v, on) => { text(`${k}: `, M + 14, y, { f: bold }); text(v, M + 14 + bold.widthOfTextAtSize(`${k}: `, 10), y, { color: on ? ink : muted }); y -= 13; };
    if (r.arrived != null) field('Arrived', r.arrived, r.arrivedRecorded);
    field(r.actualLabel, r.actual, r.recorded);
    if (r.onSite) field('Time on site', r.onSite, true);
    for (const d of r.delays) {
      if (y < 60) { page = doc.addPage([612, 792]); y = 744; }
      text(`Delay - ${d.reason}: ${d.from} to ${d.to}${d.length ? ` (${d.length})` : ''}${d.note ? ` - ${d.note}` : ''}`, M + 14, y, { size: 9 }); y -= 12;
    }
    y -= 7;
    page.drawLine({ start: { x: M, y: y + 8 }, end: { x: 612 - M, y: y + 8 }, thickness: 0.5, color: rule }); y -= 6;
  }
  doc.setTitle(`Stop times${load?.broker_load_number ? ` - ${load.broker_load_number}` : ''}`); doc.setProducer('PowerHaul TMS'); doc.setCreator('PowerHaul TMS');
  return doc.save();
}
