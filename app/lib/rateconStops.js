// Rate con stops: pickup number and full street address (Nov 2). Browser-safe, no I/O.
// The scan reads each stop's street / city / state / zip and pickup number separately. This turns that into what the
// load RPC already understands, so no SQL change is needed:
//   * stop.address = the most complete address on the page ("street, city, ST zip"). The RPC prefers the stop's
//     address over the shipper/receiver address, so a city-only stop header ("Vancouver, WA") used to win over the
//     facility's street address.
//   * the pickup number goes into reference_numbers as "PU# <n>"; the RPC writes those into the load notes'
//     "Refs:" line, which the Current Load card reads (homeCurrentLoad.pickupNumbers).

const txt = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
// A street line starts with a house number ("4800 NW Fruit Valley Rd") or is a PO box.
export const hasStreet = (s) => /^\s*\d+[a-z]?\s+\S+/i.test(txt(s)) || /\bp\.?\s*o\.?\s*box\b/i.test(txt(s));
const hasZip = (s) => /\b\d{5}(?:-\d{4})?\b/.test(txt(s));

export function composeAddress(stop) {
  if (!stop || typeof stop !== 'object') return '';
  const street = txt(stop.street);
  const city = txt(stop.city);
  const st = txt(stop.state);
  const zip = txt(stop.zip);
  const tail = [[city, st].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');
  return [street, tail].filter(Boolean).join(', ');
}

// Best address for a stop: one with a street beats one without; then one with a zip; then the longer one.
export function bestAddress(...candidates) {
  const list = candidates.map(txt).filter(Boolean);
  if (!list.length) return null;
  const score = (s) => (hasStreet(s) ? 4 : 0) + (hasZip(s) ? 2 : 0);
  return list.reduce((a, b) => (score(b) > score(a) || (score(b) === score(a) && b.length > a.length) ? b : a));
}

// "PU# 88123", "Pickup Number: 88123", "88123" → "88123". Only values with a digit count.
export function cleanPickupNumber(v) {
  let s = txt(v).replace(/^(?:p\s*\/\s*u|pu|pick[\s-]?up)\s*(?:#|no\.?|num(?:ber)?)?\s*[:#-]?\s*/i, '').trim();
  s = s.replace(/^[:#-]\s*/, '').slice(0, 80);
  return /[0-9]/.test(s) ? s : null;
}

export function normalizeRateConStops(x) {
  if (!x || typeof x !== 'object') return x;
  const out = { ...x };
  // stops[] (Nov 27): cleaned, in order. A usable list fills any top-level pickup / delivery the scan left empty.
  const listed = (Array.isArray(x.stops) ? x.stops : []).map(cleanRateConStop).filter(Boolean);
  const useList = stopsListValid(listed);
  if (useList) {
    const first = listed.find((s) => s.type === 'pickup');
    const last = [...listed].reverse().find((s) => s.type === 'delivery');
    if (!isObj(out.pickup)) out.pickup = topStop(first);
    if (!isObj(out.shipper)) out.shipper = topParty(first);
    if (!isObj(out.delivery)) out.delivery = topStop(last);
    if (!isObj(out.receiver)) out.receiver = topParty(last);
  }
  for (const [stopKey, partyKey] of [['pickup', 'shipper'], ['delivery', 'receiver']]) {
    const stop = out[stopKey] && typeof out[stopKey] === 'object' ? out[stopKey] : null;
    const party = out[partyKey] && typeof out[partyKey] === 'object' ? out[partyKey] : null;
    if (!stop && !party) continue;
    const addr = bestAddress(composeAddress(stop), stop?.address, party?.address);
    if (stop) out[stopKey] = { ...stop, address: addr };
    else if (addr) out[stopKey] = { date: null, time: null, address: addr };
  }
  const pu = cleanPickupNumber(out.pickup?.pickup_number);
  if (out.pickup && typeof out.pickup === 'object') out.pickup = { ...out.pickup, pickup_number: pu };
  if (pu) {
    const refs = (Array.isArray(out.reference_numbers) ? out.reference_numbers : []).map(txt).filter(Boolean);
    // Drop the bare copy of the same number (it would show twice in Refs) and put the labeled one first.
    const rest = refs.filter((r) => r !== pu && cleanPickupNumber(r) !== pu);
    out.reference_numbers = [`PU# ${pu}`, ...rest].slice(0, 20);
  }
  // Not usable (missing, under 2, no pickup or no delivery, over 20): the 2-stop list from the top-level fields,
  // which is what the load gets. stops_total keeps how many the rate con listed when it was over the limit.
  if (listed.length > MAX_RATECON_STOPS) out.stops_total = listed.length;
  else delete out.stops_total;
  out.stops = useList ? listed : stopsFromTopLevel(out);
  return out;
}

// Multi-stop rate cons (Nov 27). The scan also reads every stop in order into stops[] (pickups and deliveries,
// max 20). The top-level pickup / delivery (+ shipper / receiver) stay the first pickup and the last delivery, so
// anything that reads them (and the older load SQL, which ignores stops[]) keeps working. Load SQL 20261127000100
// inserts stops[] in order when it has 3 to 20 valid entries; otherwise it makes the usual 2 stops.
export const MAX_RATECON_STOPS = 20;
const STOP_TYPES = { pickup: 'pickup', delivery: 'delivery', pick: 'pickup', drop: 'delivery', dropoff: 'delivery', 'drop-off': 'delivery' };

// One scanned stop → { type, name, address, street, city, state, zip, date, time, ref_number }, or null when it has
// no usable type or nothing to place it by (no name, no address, no city).
export function cleanRateConStop(s) {
  if (!s || typeof s !== 'object') return null;
  const type = STOP_TYPES[txt(s.type).toLowerCase()];
  if (!type) return null;
  const c = (v, n) => txt(v).slice(0, n) || null;
  const out = {
    type, name: c(s.name, 200), address: null, street: c(s.street, 200), city: c(s.city, 100),
    state: c(s.state, 20), zip: c(s.zip, 20), date: c(s.date, 40), time: c(s.time, 40),
    ref_number: cleanPickupNumber(s.ref_number) || c(s.ref_number, 80),
  };
  out.address = bestAddress(composeAddress(out), s.address);
  if (!out.name && !out.address && !out.city) return null;
  return out;
}

// stops[] usable as the load's stops: 2–20 entries with at least one pickup and one delivery.
export function stopsListValid(list) {
  return Array.isArray(list) && list.length >= 2 && list.length <= MAX_RATECON_STOPS
    && list.some((s) => s?.type === 'pickup') && list.some((s) => s?.type === 'delivery');
}

// Top-level stop/party from a stops[] entry (only used to fill a top-level field the scan left empty).
const topStop = (s) => ({ date: s.date, time: s.time, address: s.address, street: s.street, city: s.city, state: s.state, zip: s.zip, pickup_number: s.type === 'pickup' ? s.ref_number : null });
const topParty = (s) => ({ name: s.name, address: s.address });
const isObj = (v) => !!v && typeof v === 'object';

// The 2-stop list made from the top-level fields (old scans, or a stops[] that wasn't usable).
export function stopsFromTopLevel(x) {
  const out = [];
  for (const [type, stopKey, partyKey] of [['pickup', 'pickup', 'shipper'], ['delivery', 'delivery', 'receiver']]) {
    const st = isObj(x?.[stopKey]) ? x[stopKey] : null;
    const p = isObj(x?.[partyKey]) ? x[partyKey] : null;
    if (!st && !p) continue;
    const s = cleanRateConStop({ type, name: p?.name, address: bestAddress(st?.address, p?.address), street: st?.street, city: st?.city,
      state: st?.state, zip: st?.zip, date: st?.date, time: st?.time, ref_number: type === 'pickup' ? st?.pickup_number : null });
    if (s) out.push(s);
  }
  return out;
}

// The stops a review screen shows for an extracted rate con (old rows without stops[] → from the top-level fields).
export function rateConStops(x) {
  if (!isObj(x)) return [];
  if (Array.isArray(x.stops) && x.stops.length) return x.stops.filter(isObj);
  return stopsFromTopLevel(x);
}

// Review screen text (Documents → Needs attention / upload / emailed drafts).
export const stopsFoundLabel = (n) => `${n} ${n === 1 ? 'stop' : 'stops'} found`;
// How many stops the rate con lists (over the limit: the real count, though the load gets 2).
export const rateConStopCount = (x) => (Number.isInteger(x?.stops_total) && x.stops_total > MAX_RATECON_STOPS ? x.stops_total : rateConStops(x).length);
export const stopTypeLabel = (t) => (t === 'pickup' ? 'Pickup' : t === 'delivery' ? 'Delivery' : 'Stop');
// "2026-11-30 08:00 · Ref 123"
export const stopWhenLine = (s) => [[s?.date, s?.time].filter(Boolean).join(' '), s?.ref_number ? `Ref ${s.ref_number}` : ''].filter(Boolean).join(' · ');
// A note under the list when the load won't get every stop. sqlReady: false = the database can't add the extra stops
// yet (migration 20261127000100 not applied), anything else = it can.
export function stopsNote(x, sqlReady) {
  const n = rateConStopCount(x);
  if (n > MAX_RATECON_STOPS) return `This rate con lists ${n} stops, more than the ${MAX_RATECON_STOPS} a load can take from it. The load gets the first pickup and the last delivery. Add the other stops in Dispatch.`;
  if (n >= 3 && sqlReady === false) return 'For now the load gets the first pickup and the last delivery only. Add the other stops in Dispatch after you create the load.';
  return null;
}
