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

function normalizeReceipt(raw, { today = isoToday() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);

  let amount = typeof r.amount === 'number' ? r.amount : typeof r.amount === 'string' ? Number(r.amount.replace(/[$,\s]/g, '')) : NaN;
  amount = Number.isFinite(amount) && amount >= 0 && amount < 1_000_000 ? Math.round(amount * 100) / 100 : null;

  let expense_date = null;
  if (typeof r.expense_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.expense_date)) {
    const [y, m, d] = r.expense_date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    // Allow one day of slack for timezones; reject future dates and absurdly old ones.
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    if (valid && y >= 2000 && r.expense_date <= tomorrow) expense_date = r.expense_date > today ? today : r.expense_date;
  }

  const cat = typeof r.category === 'string' ? r.category.trim().toLowerCase() : '';
  const category = RECEIPT_CATEGORIES.includes(cat) ? cat : null;

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
  };
}

export const DOC_TYPES = {
  receipt: {
    name: 'expense_receipt',
    prompt:
      'You are reading a photo of a trucking expense receipt. Extract: amount = the TOTAL actually paid in USD including tax and tip (a number, not the subtotal); ' +
      'expense_date = the transaction date as YYYY-MM-DD; category = one of fuel, tolls, maintenance, food, lodging, other ' +
      '(diesel/DEF/gas station fuel purchase = fuel, toll plaza/E-ZPass/PrePass = tolls, repairs/parts/tires/truck wash/oil = maintenance, ' +
      'restaurants/groceries/convenience food = food, hotels/motels = lodging); vendor = merchant name (and store number if shown); ' +
      'description = a short summary (e.g. "142.3 gal diesel"); confidence 0..1 for the overall reading; notes = anything uncertain. ' +
      'If the image is not a receipt or is unreadable, set is_receipt false and the fields null. Use null for anything not present. Never guess an amount.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['is_receipt', 'amount', 'expense_date', 'category', 'vendor', 'description', 'confidence', 'notes'],
      properties: {
        is_receipt: { type: 'boolean' },
        amount: { type: ['number', 'null'], description: 'Total paid in USD incl. tax' },
        expense_date: { ...str, description: 'YYYY-MM-DD' },
        category: { type: ['string', 'null'], enum: [...RECEIPT_CATEGORIES, null] },
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
