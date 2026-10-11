// Server-only helper for AI document extraction (OpenAI Responses API, structured JSON output).
// Each doc type supplies { name, prompt, schema, normalize }. Only 'receipt' is wired up today;
// BOL etc. can add an entry to DOC_TYPES and reuse runExtraction().

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];
export const pickModel = () => (ALLOWED_MODELS.includes(process.env.OPENAI_MODEL) ? process.env.OPENAI_MODEL : DEFAULT_MODEL);

export const RECEIPT_CATEGORIES = ['fuel', 'tolls', 'maintenance', 'food', 'lodging', 'other'];

const str = { type: ['string', 'null'] };

function isoToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Whole month names and standard abbreviations only (no substrings like "mayo" or "decal").
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const monthOf = (w) => (typeof w === 'string' && Object.prototype.hasOwnProperty.call(MONTHS, w) ? MONTHS[w] : null);
const pad = (n) => String(n).padStart(2, '0');
const isRealDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const yearOf = (yy) => (yy == null ? null : yy.length === 2 ? 2000 + +yy : +yy);

// Resolve one {y?, m, d} candidate to YYYY-MM-DD <= latest, or null.
function resolveCandidate({ y, m, d }, latest) {
  if (!m || !d || m > 12 || d > 31) return null;
  if (y == null) {
    const ly = +latest.slice(0, 4);
    for (const cand of [ly, ly - 1]) {
      if (isRealDate(cand, m, d) && `${cand}-${pad(m)}-${pad(d)}` <= latest) return `${cand}-${pad(m)}-${pad(d)}`;
    }
    return null;
  }
  if (y < 2000 || !isRealDate(y, m, d)) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return iso <= latest ? iso : null;
}

// Deterministically parse a printed receipt date (US month-first). Returns YYYY-MM-DD or null.
// Collects EVERY date-like candidate in the text (9/26, 09/26/26, 9-26-2026, 09.26.26, 2026-09-26,
// "Sep 26, 2026", "Sept 26", "26 September 2026"), in order of appearance, and returns the first
// that is a real, non-future date. Year missing -> most recent past occurrence (<= latest).
// Never substitutes today.
export function parseReceiptDate(raw, latest) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const cands = [];
  const ymd = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  const mdy = /\b(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?\b/g;
  const mon = /\b([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}|\d{2}))?\b/g;
  const dmon = /\b(\d{1,2}) ([a-z]{3,9})\.?(?: (\d{4}|\d{2}))?\b/g;
  const taken = []; // spans of ISO matches, so "2026-09-26" isn't re-read as "09-26"
  for (const x of s.matchAll(ymd)) { cands.push({ i: x.index, y: +x[1], m: +x[2], d: +x[3] }); taken.push([x.index, x.index + x[0].length]); }
  const inTaken = (i) => taken.some(([a, b]) => i >= a && i < b);
  for (const x of s.matchAll(mdy)) if (!inTaken(x.index)) cands.push({ i: x.index, y: yearOf(x[3]), m: +x[1], d: +x[2] });
  for (const x of s.matchAll(mon)) { const m = monthOf(x[1]); if (m) cands.push({ i: x.index, y: yearOf(x[3]), m, d: +x[2] }); }
  for (const x of s.matchAll(dmon)) { const m = monthOf(x[2]); if (m) cands.push({ i: x.index, y: yearOf(x[3]), m, d: +x[1] }); }
  cands.sort((a, b) => a.i - b.i);
  for (const c of cands) {
    const iso = resolveCandidate(c, latest);
    if (iso) return iso;
  }
  return null;
}

// Receipt auto-fill rate limits: the single JS definition (used for user-facing messages).
// Enforcement lives in claim_extraction_slot (migration 20261010000730, already applied); keep these in sync.
export const RECEIPT_RATE_LIMIT = { perHour: 30, perDay: 150 };

// today: the client's local YYYY-MM-DD (preferred) or the server date.
// todaySlackDays: 0 when the client's date is known; 1 for the server fallback (timezones).
function normalizeReceipt(raw, { today = isoToday(), todaySlackDays = 0 } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);

  let amount = typeof r.amount === 'number' ? r.amount : typeof r.amount === 'string' ? Number(r.amount.replace(/[$,\s]/g, '')) : NaN;
  amount = Number.isFinite(amount) && amount >= 0 && amount < 1_000_000 ? Math.round(amount * 100) / 100 : null;

  // Date: only when the model actually read a printed date (date_raw), it's a real calendar date,
  // and it isn't in the future. Never substitute or clamp to today: an unreadable/future date is null,
  // so the form keeps its value and the field isn't marked auto-filled.
  const date_raw = clip(r.date_raw, 40);
  const latest = new Date(Date.parse(today + 'T00:00:00Z') + todaySlackDays * 86400000).toISOString().slice(0, 10);
  // Prefer our own parse of the printed text; fall back to the model's YYYY-MM-DD only if it's real and not future.
  let expense_date = date_raw ? parseReceiptDate(date_raw, latest) : null;
  let date_source = expense_date ? 'parsed' : null;
  if (!expense_date && date_raw && typeof r.expense_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.expense_date)) {
    const [y, m, d] = r.expense_date.split('-').map(Number);
    if (y >= 2000 && isRealDate(y, m, d) && r.expense_date <= latest) { expense_date = r.expense_date; date_source = 'model'; }
  }

  // Category: allowlisted and only when the model says it's confident; otherwise null (not a guess).
  const cat = typeof r.category === 'string' ? r.category.trim().toLowerCase() : '';
  const category = RECEIPT_CATEGORIES.includes(cat) && r.category_confident === true ? cat : null;

  let confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : null;
  const is_receipt = r.is_receipt !== false;
  if (!is_receipt) confidence = 0;

  return {
    is_receipt,
    amount: is_receipt ? amount : null,
    expense_date: is_receipt ? expense_date : null,
    category: is_receipt ? category : null,
    vendor: is_receipt ? clip(r.vendor, 80) : null,
    description: is_receipt ? clip(r.description, 120) : null,
    confidence,
    notes: clip(r.notes, 200),
    // Debug only (logged server-side, not returned to the client).
    _debug: { date_raw, model_date: typeof r.expense_date === 'string' ? r.expense_date : null, date_source, model_category: cat || null, category_confident: r.category_confident === true },
  };
}

export const DOC_TYPES = {
  receipt: {
    name: 'expense_receipt',
    prompt: [
      'You are reading a photo of a US trucking expense receipt. Return JSON only.',
      'amount: the TOTAL actually paid in USD, including tax and tip (a number). Not the subtotal. Never guess an amount.',
      'date_raw: the transaction date EXACTLY as printed on the receipt (e.g. "10/03/26", "Oct 3, 2026", "2026-10-03 14:22"), or null if no date is printed or legible.',
      'expense_date: date_raw converted to YYYY-MM-DD. US receipts print month first: MM/DD/YY or MM/DD/YYYY (09/26/26 = 2026-09-26). A 2-digit year YY means 20YY. If the year is not printed, still copy the month/day into date_raw exactly. ' +
        'Use ONLY the date printed on the receipt. If date_raw is null, expense_date MUST be null. NEVER use today\'s date or any guessed date.',
      'category: the single best category by the type of merchant, using these rules:',
      '- food: restaurants, fast food, cafes, diners, truck stop restaurants, grocery stores, convenience-store food or drinks.',
      '- fuel: gas stations / truck stops when the purchase is fuel: diesel, gasoline, DEF, reefer fuel.',
      '- lodging: hotels, motels, inns, truck stop showers/rooms.',
      '- tolls: toll roads/plazas, E-ZPass/I-PASS/PrePass, weigh/scale tickets (CAT scale), PARKING (parking garages, parking lots, meters, truck parking).',
      '- maintenance: repairs, parts, tires, oil changes, truck/trailer wash, roadside service, towing.',
      '- other: ONLY as a last resort when none of the above fit.',
      'A gas-station receipt for food or drinks only is food, not fuel. Do not choose fuel unless fuel was actually purchased.',
      'category_confident: true only if the merchant/items clearly indicate the category; otherwise false (and category may be null).',
      'vendor: merchant name (and store number if shown). description: short summary (e.g. "142.3 gal diesel", "Parking 3 hrs").',
      'confidence: 0..1 for the overall reading. notes: anything uncertain.',
      'If the image is not a receipt or is unreadable, set is_receipt false and all other fields null.',
    ].join('\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['is_receipt', 'amount', 'date_raw', 'expense_date', 'category', 'category_confident', 'vendor', 'description', 'confidence', 'notes'],
      properties: {
        is_receipt: { type: 'boolean' },
        amount: { type: ['number', 'null'], description: 'Total paid in USD incl. tax' },
        date_raw: { ...str, description: 'Transaction date exactly as printed, or null' },
        expense_date: { ...str, description: 'YYYY-MM-DD from date_raw only, else null' },
        category: { type: ['string', 'null'], enum: ['food', 'lodging', 'tolls', 'maintenance', 'fuel', 'other', null] },
        category_confident: { type: 'boolean' },
        vendor: str,
        description: str,
        confidence: { type: ['number', 'null'] },
        notes: str,
      },
    },
    normalize: normalizeReceipt,
    maxOutputTokens: 600,
  },
};

// Calls OpenAI with one image (data URL). Returns { data } or { error: { status, publicMsg, log: [...] } }.
export async function runExtraction(docType, { apiKey, dataUrl, timeoutMs = 45_000, normalizeOpts } = {}) {
  const cfg = DOC_TYPES[docType];
  if (!cfg) return { error: { status: 500, log: ['unknown docType', docType] } };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res, body;
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: pickModel(),
        max_output_tokens: cfg.maxOutputTokens || 1000,
        input: [{ role: 'user', content: [{ type: 'input_text', text: cfg.prompt }, { type: 'input_image', image_url: dataUrl }] }],
        text: { format: { type: 'json_schema', name: cfg.name, strict: true, schema: cfg.schema } },
      }),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    if (err.name === 'AbortError') return { error: { status: 504, timeout: true, log: ['OpenAI timeout'] } };
    return { error: { status: 502, log: ['OpenAI fetch', err.message] } };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { error: { status: 502, log: ['OpenAI', res.status, body?.error?.message] } };
  const text = body.output_text ?? body.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { error: { status: 502, log: ['parse', body?.status, body?.incomplete_details] } }; }
  return { data: cfg.normalize(parsed, normalizeOpts) };
}
