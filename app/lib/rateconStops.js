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
  return out;
}
