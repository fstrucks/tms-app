// "Rescan rate con" (Nov 2): fill ONLY empty fields on a load from a fresh scan of its rate con. Browser-safe, no I/O.
// Rules (never overwrite anything the user typed):
//   * stop street (address_line1): filled when empty or when it only repeats the stop's city ("Vancouver" /
//     "Vancouver, WA"). A value with a street on it is never replaced, and neither is any other text.
//   * stop city / state / zip: filled only when empty.
//   * pickup stop pickup_number: filled only when empty.
//   * load notes: "PU# <n>" is added to the Refs line only when that number isn't in the notes already.
// The server re-plans against the load's current values on Save, so a field typed after the preview is kept.
import { hasStreet, cleanPickupNumber } from './rateconStops.js';

const txt = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const STATE = /^[A-Z]{2}$/;
const ZIP = /^\d{5}(?:-\d{4})?$/;
export const FIELD_LABELS = { address_line1: 'Street', city: 'City', state: 'State', zip: 'ZIP', pickup_number: 'Pickup #' };

// "100 Example Way, Vancouver, WA 98660" → parts. Only a clean "street, city, ST zip" shape is split.
export function splitAddress(s) {
  const m = txt(s).match(/^(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?(?:\s+(\d{5}(?:-\d{4})?))?$/);
  if (!m) return {};
  return { street: m[1], city: m[2], state: m[3].toUpperCase(), zip: m[4] || '' };
}

// Scanned stop → clean { street, city, state, zip }. The split fields win; the address string fills gaps.
export function scannedParts(stop) {
  if (!stop || typeof stop !== 'object') return { street: '', city: '', state: '', zip: '' };
  const a = splitAddress(stop.address);
  const street = [txt(stop.street), txt(a.street)].find(hasStreet) || '';
  const city = (txt(stop.city) || txt(a.city)).slice(0, 100);
  const state = (txt(stop.state) || txt(a.state)).toUpperCase();
  const zip = txt(stop.zip) || txt(a.zip);
  return { street: street.slice(0, 200), city, state: STATE.test(state) ? state : '', zip: ZIP.test(zip) ? zip : '' };
}

// What the scan read, trimmed to what a rescan may use (this is also what Save sends back).
export function rescanScan(extracted) {
  const x = extracted && typeof extracted === 'object' ? extracted : {};
  return { pickup: scannedParts(x.pickup), delivery: scannedParts(x.delivery), pickup_number: cleanPickupNumber(x.pickup?.pickup_number) || '' };
}

// The scan as sent back by the client on Save: re-cleaned, never trusted as-is.
export function cleanScan(s) {
  const x = s && typeof s === 'object' ? s : {};
  return { pickup: scannedParts(x.pickup), delivery: scannedParts(x.delivery), pickup_number: cleanPickupNumber(typeof x.pickup_number === 'string' ? x.pickup_number : '') || '' };
}

const norm = (s) => txt(s).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
// A street field that is empty, or only the city ("Vancouver", "Vancouver, WA", "Vancouver WA 98660").
export function streetIsFillable(stop) {
  const v = txt(stop?.address_line1);
  if (!v) return true;
  if (hasStreet(v)) return false;
  const city = norm(stop?.city);
  if (!city) return false;
  const n = norm(v).replace(/\s\d{5}(?:-\d{4})?$/, '');
  const st = norm(stop?.state);
  return n === city || (!!st && n === `${city} ${st}`);
}

const sorted = (stops) => [...(stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
// First pickup and last delivery: the rate con's two stops.
export function targetStops(stops) {
  const s = sorted(stops);
  return { pickup: s.find((x) => x.stop_type === 'pickup') || null, delivery: [...s].reverse().find((x) => x.stop_type === 'delivery') || null };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function notesHasNumber(notes, n) {
  return !!n && new RegExp(`(^|[^0-9A-Za-z])${esc(n)}($|[^0-9A-Za-z])`).test(notes || '');
}
// Add "PU# n" to the notes' Refs line (or a new Refs line). null when nothing to add.
export function notesWithPickup(notes, n) {
  if (!n || notesHasNumber(notes, n)) return null;
  const cur = typeof notes === 'string' ? notes : '';
  const lines = cur ? cur.split('\n') : [];
  const i = lines.findIndex((l) => /^Refs:/.test(l));
  if (i >= 0) lines[i] = `${lines[i].replace(/\s+$/, '')}, PU# ${n}`;
  else lines.push(`Refs: PU# ${n}`);
  return lines.join('\n').slice(0, 5000);
}

export const changeKey = (c) => (c.field === 'notes' ? 'notes' : `${c.stopId}:${c.field}`);

// load = { notes, stops[] }, scan = rescanScan(...) → [{ key, stopId?, stopType?, field, label, from, to }]
export function planRescan(load, scan) {
  const out = [];
  const s = scan || {};
  const t = targetStops(load?.stops);
  for (const type of ['pickup', 'delivery']) {
    const stop = t[type];
    const p = s[type];
    if (!stop || !p) continue;
    const add = (field, to) => out.push({ stopId: stop.id, stopType: type, field, label: FIELD_LABELS[field], from: stop[field] || '', to });
    if (p.street && hasStreet(p.street) && streetIsFillable(stop)) add('address_line1', p.street);
    if (p.city && !txt(stop.city)) add('city', p.city);
    if (p.state && STATE.test(p.state) && !txt(stop.state)) add('state', p.state);
    if (p.zip && ZIP.test(p.zip) && !txt(stop.zip)) add('zip', p.zip);
    if (type === 'pickup' && s.pickup_number && !txt(stop.pickup_number)) add('pickup_number', String(s.pickup_number).slice(0, 80));
  }
  const notes = notesWithPickup(load?.notes, cleanPickupNumber(s.pickup_number));
  if (notes != null) out.push({ field: 'notes', label: 'Notes', from: load?.notes || '', to: notes });
  return out.map((c) => ({ ...c, key: changeKey(c) }));
}

// Group accepted changes into one update per stop, plus the notes value.
export function rescanUpdates(changes, accept) {
  const ok = new Set(Array.isArray(accept) ? accept : []);
  const stops = {};
  let notes = null;
  for (const c of changes) {
    if (!ok.has(c.key)) continue;
    if (c.field === 'notes') notes = c;
    else (stops[c.stopId] ||= {})[c.field] = c.to;
  }
  return { stops, notes };
}
