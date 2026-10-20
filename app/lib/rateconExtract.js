// Rate con AI reader, shared by /api/extract (Documents upload) and the rate con email-in (lib/rateconEmail.js).
// Moved out of app/api/extract/route.js unchanged: same schema, prompt, model choice and timeout.
import { loadPdfjs } from './packetPdfText.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];
export const OPENAI_TIMEOUT_MS = 50_000;
export const pickModel = (env) => (ALLOWED_MODELS.includes(env) ? env : DEFAULT_MODEL);

const str = { type: ['string', 'null'] };
const party = { type: ['object', 'null'], additionalProperties: false, required: ['name', 'address'], properties: { name: { ...str, description: 'Facility / company name (e.g. "Acme Foods DC"), not the address' }, address: str } };
const stop = { type: ['object', 'null'], additionalProperties: false, required: ['date', 'time', 'address'], properties: { date: str, time: str, address: str } };
export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['document_kind', 'heading_text', 'broker_name', 'load_number', 'reference_numbers', 'shipper', 'receiver', 'pickup', 'delivery', 'rate', 'equipment_type', 'weight', 'total_miles', 'notes'],
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
    rate: { type: ['number', 'null'], description: 'Total linehaul/all-in rate in USD' },
    equipment_type: { ...str, description: 'Trailer/equipment required, as written, e.g. "53\' Dry Van", "Reefer", "Flatbed"' },
    // Truck tab compares scale tickets with this (PR #69 fix A). Text as printed; parsed to weight_lb below.
    weight: { ...str, description: 'Total cargo/load weight exactly as printed, with units, e.g. "38,500 lbs"' },
    // PR A (rate con miles): the trip distance the broker prints. Copied to an EMPTY loads.total_miles only.
    total_miles: { type: ['number', 'null'], description: 'Total (or loaded) trip miles for the whole load as printed by the broker, e.g. "Miles (loaded) 626", "Distance 314mi", "Linehaul (1,270 mi)". null if not printed. Never from driving directions.' },
    notes: str,
  },
};

export const PROMPT = 'First set document_kind: "coi" if this is a certificate of insurance (ACORD 25, "Certificate of Liability Insurance", PRODUCER / INSURER A / CERTIFICATE HOLDER boxes), "rate_confirmation" if it is a trucking rate/load confirmation, "bol" if it is a bill of lading, "scale_ticket" if it is a truck scale (CAT Scale) weight ticket, else "other". For a bill of lading still copy any load / PO / BOL numbers into load_number and reference_numbers and the ship date into pickup. Copy the title and main labels into heading_text. Then extract the load details from the rate confirmation. Use null for anything not present (all load fields null if it is not a rate confirmation). Dates as YYYY-MM-DD when possible. rate is the total carrier pay in USD as a number. weight is the total cargo weight exactly as printed, with units. total_miles is the total or loaded trip distance for the whole load (pickup to final delivery) as a number, only when the document prints it as a load figure, e.g. a Miles / Loaded miles / Distance / Total miles field, or the miles on a linehaul or per-mile charge line ("626 mi x $0.40/mi", "Linehaul (1,270 mi)"). IGNORE any miles that appear only inside driving directions, route or turn-by-turn instructions, or facility/gate directions (e.g. "17.2 miles north to a 4-way stop", "exit 562 then 1.1 miles"): those are never the trip distance. Do not add segments up, do not estimate from addresses, and use null when no trip distance is printed.';

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
        max_output_tokens: 1500,
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
