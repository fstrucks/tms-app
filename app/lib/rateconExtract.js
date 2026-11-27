// Rate con AI reader, shared by /api/extract (Documents upload) and the rate con email-in (lib/rateconEmail.js).
// Moved out of app/api/extract/route.js unchanged: same schema, prompt, model choice and timeout. Nov 27: stops[] added.
import { loadPdfjs } from './packetPdfText.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];
export const OPENAI_TIMEOUT_MS = 50_000;
export const pickModel = (env) => (ALLOWED_MODELS.includes(env) ? env : DEFAULT_MODEL);

const str = { type: ['string', 'null'] };
const party = { type: ['object', 'null'], additionalProperties: false, required: ['name', 'address'], properties: { name: { ...str, description: 'Facility / company name (e.g. "Acme Foods DC"), not the address' }, address: str } };
// Nov 2: street / city / state / zip and the pickup number per stop (see lib/rateconStops.js for how they're used).
const stop = {
  type: ['object', 'null'], additionalProperties: false,
  required: ['date', 'time', 'address', 'street', 'city', 'state', 'zip', 'pickup_number'],
  properties: {
    date: str, time: str,
    address: { ...str, description: 'Full street address of this stop as printed: street, city, state, zip' },
    street: { ...str, description: 'Street line only, e.g. "4800 NW Fruit Valley Rd" (often printed on its own line under the facility name)' },
    city: str,
    state: { ...str, description: 'Two-letter state code' },
    zip: str,
    pickup_number: { ...str, description: 'Pickup stop only: the number the shipper needs to release the load, labeled e.g. "Pickup #", "PU#", "Pickup Number", "Shipper Ref", "Appointment ID" / "Appt #" when that is the pickup reference. null for deliveries or if not printed.' },
  },
};
// Nov 27 (multi-stop rate cons): every stop in order. The top-level pickup / delivery stay the first pickup and the
// last delivery (see normalizeRateConStops in lib/rateconStops.js).
const listedStop = {
  type: 'object', additionalProperties: false,
  required: ['type', 'name', 'address', 'street', 'city', 'state', 'zip', 'date', 'time', 'ref_number'],
  properties: {
    type: { type: 'string', enum: ['pickup', 'delivery'], description: 'pickup = load / shipper stop; delivery = unload / consignee / receiver stop' },
    name: { ...str, description: 'Facility / company name at this stop, not the address' },
    address: { ...str, description: 'Full street address of this stop as printed: street, city, state, zip' },
    street: { ...str, description: 'Street line only' },
    city: str,
    state: { ...str, description: 'Two-letter state code' },
    zip: str,
    date: { ...str, description: 'Appointment / ready date, YYYY-MM-DD when possible' },
    time: { ...str, description: 'Appointment time or time window as printed, e.g. "08:00" or "08:00-14:00"' },
    ref_number: { ...str, description: 'This stop\'s pickup / delivery / appointment / PO reference number, without its label. null if not printed.' },
  },
};
export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['document_kind', 'heading_text', 'broker_name', 'load_number', 'reference_numbers', 'shipper', 'receiver', 'pickup', 'delivery', 'stops', 'rate', 'equipment_type', 'weight', 'total_miles', 'notes'],
  properties: {
    // Classification: a COI uploaded through the rate-con path must not be saved as a rate confirmation.
    document_kind: { type: 'string', enum: ['rate_confirmation', 'coi', 'bol', 'scale_ticket', 'other'], description: 'coi = certificate of insurance / ACORD 25; bol = bill of lading; scale_ticket = truck scale / CAT scale ticket' },
    heading_text: { ...str, description: 'The document title and main section labels, copied as printed (e.g. "CERTIFICATE OF LIABILITY INSURANCE, PRODUCER, INSURER A, CERTIFICATE HOLDER")' },
    broker_name: str,
    load_number: str,
    reference_numbers: { type: ['array', 'null'], items: { type: 'string' } },
    shipper: party,
    receiver: party,
    pickup: stop,
    delivery: stop,
    stops: { type: ['array', 'null'], items: listedStop, description: 'Every pickup and delivery stop in route order (stop 1, stop 2, ...), at most 20. Include the first pickup and the final delivery here too.' },
    rate: { type: ['number', 'null'], description: 'Total linehaul/all-in rate in USD' },
    equipment_type: { ...str, description: 'Trailer/equipment required, as written, e.g. "53\' Dry Van", "Reefer", "Flatbed"' },
    // Truck tab compares scale tickets with this (PR #69 fix A). Text as printed; parsed to weight_lb below.
    weight: { ...str, description: 'Total cargo/load weight exactly as printed, with units, e.g. "38,500 lbs"' },
    // PR A (rate con miles): the trip distance the broker prints. Copied to an EMPTY loads.total_miles only.
    total_miles: { type: ['number', 'null'], description: 'Total (or loaded) trip miles for the whole load as printed by the broker, e.g. "Miles (loaded) 626", "Distance 314mi", "Linehaul (1,270 mi)". null if not printed. Never from driving directions.' },
    notes: str,
  },
};

export const PROMPT = 'First set document_kind: "coi" if this is a certificate of insurance (ACORD 25, "Certificate of Liability Insurance", PRODUCER / INSURER A / CERTIFICATE HOLDER boxes), "rate_confirmation" if it is a trucking rate/load confirmation, "bol" if it is a bill of lading, "scale_ticket" if it is a truck scale (CAT Scale) weight ticket, else "other". For a bill of lading still copy any load / PO / BOL numbers into load_number and reference_numbers and the ship date into pickup. Copy the title and main labels into heading_text. Then extract the load details from the rate confirmation. Use null for anything not present (all load fields null if it is not a rate confirmation). Dates as YYYY-MM-DD when possible. rate is the total carrier pay in USD as a number. weight is the total cargo weight exactly as printed, with units. total_miles is the total or loaded trip distance for the whole load (pickup to final delivery) as a number, only when the document prints it as a load figure, e.g. a Miles / Loaded miles / Distance / Total miles field, or the miles on a linehaul or per-mile charge line ("626 mi x $0.40/mi", "Linehaul (1,270 mi)"). IGNORE any miles that appear only inside driving directions, route or turn-by-turn instructions, or facility/gate directions (e.g. "17.2 miles north to a 4-way stop", "exit 562 then 1.1 miles"): those are never the trip distance. Do not add segments up, do not estimate from addresses, and use null when no trip distance is printed. For each stop (pickup and delivery) copy the facility\'s full street address into address and also split it into street, city, state and zip; the street line is often printed on its own line under the facility name, separate from a "City, ST" header, so look under the facility name and do not stop at the city. pickup.pickup_number is the pickup / PU / shipper reference number for the pickup stop, without its label; also keep it in reference_numbers. Many rate cons have more than one pickup or delivery (extra stops, stop 1 / stop 2 / stop 3, multiple shippers or consignees): list EVERY stop in route order in stops, at most 20, each with its type (pickup or delivery), facility name, address split as above, date, time and its own reference number; do not skip middle stops. pickup and shipper are the FIRST pickup; delivery and receiver are the LAST delivery. For a simple one-pickup, one-delivery load, stops has those two.';

// One model call. Returns { ok: true, extracted } or { ok: false, status: 'timeout' | 'error', log }.
// Never logs or returns the file or the key.
export async function callRateConModel({ apiKey, model, mime, name, bytes, fetchImpl = fetch, timeoutMs = OPENAI_TIMEOUT_MS }) {
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  const filePart = mime === 'application/pdf'
    ? { type: 'input_file', filename: name, file_data: dataUrl }
    : { type: 'input_image', image_url: dataUrl };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let aiRes, aiBody;
  try {
    aiRes = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false, // don't keep the request/response on OpenAI's side
        max_output_tokens: 4000, // Nov 27: room for up to 20 stops
        input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }, filePart] }],
        text: { format: { type: 'json_schema', name: 'rate_confirmation', strict: true, schema } },
      }),
    });
    aiBody = await aiRes.json().catch(() => ({}));
  } catch (err) {
    return err.name === 'AbortError' ? { ok: false, status: 'timeout', log: ['OpenAI timeout'] } : { ok: false, status: 'error', log: ['OpenAI fetch', err.message] };
  } finally {
    clearTimeout(timer);
  }
  if (!aiRes.ok) return { ok: false, status: 'error', log: ['OpenAI', aiRes.status, aiBody?.error?.message] };
  const text = aiBody.output_text
    ?? aiBody.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text;
  try { return { ok: true, extracted: JSON.parse(text) }; } catch { return { ok: false, status: 'error', log: ['parse', aiBody?.status, aiBody?.incomplete_details] }; }
}

// Text of the first pages of a digital PDF (empty for scans or on any error).
export async function pdfTextOf(bytes) {
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    let out = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 2); i++) out += ' ' + (await (await pdf.getPage(i)).getTextContent()).items.map((it) => it.str).join(' ');
    return out;
  } catch { return ''; }
}
