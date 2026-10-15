// ELD mileage CSV import: pure helpers (no React / Supabase) so they are unit-testable.
// Works with any ELD export: columns are auto-detected from header synonyms, then the
// user can confirm/adjust the mapping. Each row gets a stable hash for duplicate prevention.

export const FIELDS = [
  { key: 'date', label: 'Date', required: true },
  { key: 'truck', label: 'Truck / vehicle', required: false },
  { key: 'state', label: 'State / jurisdiction', required: true },
  { key: 'miles', label: 'Miles', required: false },
  { key: 'start_odometer', label: 'Start odometer', required: false },
  { key: 'end_odometer', label: 'End odometer', required: false },
  { key: 'fuel_gallons', label: 'Fuel gallons (optional)', required: false },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Normalized header synonyms, most specific first.
export const SYNONYMS = {
  date: ['date', 'trip date', 'log date', 'day', 'entry date', 'report date', 'travel date', 'start date', 'month', 'period', 'report month'],
  truck: ['vehicle', 'truck', 'truck number', 'truck no', 'truck', 'unit', 'unit number', 'unit no', 'vehicle name', 'vehicle id', 'vehicle number', 'asset', 'tractor', 'power unit'],
  state: ['state', 'jurisdiction', 'juris', 'state province', 'province', 'region', 'state code', 'ifta state', 'st'],
  miles: ['miles', 'total miles', 'distance', 'distance mi', 'distance miles', 'mileage', 'miles driven', 'total distance', 'taxable miles', 'state miles', 'jurisdiction miles'],
  start_odometer: ['start odometer', 'odometer start', 'start odo', 'odo start', 'beginning odometer', 'begin odometer', 'starting odometer', 'odometer begin', 'odometer in', 'start odometer mi'],
  end_odometer: ['end odometer', 'odometer end', 'end odo', 'odo end', 'ending odometer', 'odometer out', 'stop odometer', 'final odometer', 'end odometer mi'],
  fuel_gallons: ['fuel gallons', 'gallons', 'fuel gal', 'fuel', 'fuel purchased', 'gallons purchased', 'fuel qty', 'fuel quantity', 'tax paid gallons', 'gal'],
};

// RFC 4180-ish parser: quotes, escaped quotes, CRLF, BOM. Skips fully blank lines.
export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(src);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!clean.length) return { headers: [], rows: [] };
  const headers = clean[0].map((h) => h.trim());
  return { headers, rows: clean.slice(1).map((r) => r.map((c) => c.trim())) };
}

function sniffDelimiter(src) {
  const first = src.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

// Returns { field: headerIndex | -1 }. Exact synonym matches win over partial ones; a header
// is used for at most one field.
export function detectMapping(headers) {
  const h = headers.map(norm);
  const used = new Set();
  const out = {};
  for (const pass of ['exact', 'partial']) {
    for (const f of FIELDS) {
      if (out[f.key] >= 0) continue;
      out[f.key] = -1;
      for (const syn of SYNONYMS[f.key]) {
        const idx = h.findIndex((x, i) => !used.has(i) && (pass === 'exact' ? x === syn
          : syn.length > 3 && (x.startsWith(syn + ' ') || x.endsWith(' ' + syn) || x.includes(' ' + syn + ' '))));
        if (idx >= 0) { out[f.key] = idx; used.add(idx); break; }
      }
    }
  }
  return out;
}

// Name -> index mapping, for saving: stored by header name so it survives column reordering.
export const mappingToNames = (mapping, headers) =>
  Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, i >= 0 ? headers[i] : null]));
export function mappingFromNames(names, headers) {
  const h = headers.map(norm);
  const out = {};
  for (const f of FIELDS) {
    const n = names?.[f.key];
    out[f.key] = n ? h.indexOf(norm(n)) : -1;
  }
  return out;
}
// A saved mapping applies to a file when every header it names is present.
export const mappingFits = (names, headers) =>
  Object.values(names || {}).filter(Boolean).every((n) => headers.map(norm).includes(norm(n)));

const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY '
  + 'AB BC MB NB NL NS NT NU ON PE QC SK YT').split(' '));
const STATE_NAMES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', ontario: 'ON', quebec: 'QC', 'british columbia': 'BC', alberta: 'AB', manitoba: 'MB', saskatchewan: 'SK' };

export function parseState(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (STATES.has(up)) return up;
  return STATE_NAMES[s.toLowerCase().replace(/\s+/g, ' ')] || null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Also YYYY-MM and 'Sep 2026' (month-only reports, mapped to the 1st).
// Accepts YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, M/D/YY, MM-DD-YYYY, ISO datetimes. Returns YYYY-MM-DD or null.
export function parseDate(v) {
  const s = String(v || '').trim();
  let y, m, d, r;
  if ((r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) [, y, m, d] = r;
  else if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/))) { [, m, d, y] = r; if (y.length === 2) y = '20' + y; }
  else if ((r = s.match(/^(\d{4})[-/](\d{1,2})$/))) { [, y, m] = r; d = 1; } // month-only (e.g. Samsara monthly) -> 1st
  else if ((r = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/)) && MONTHS[r[1].slice(0, 3).toLowerCase()]) { y = r[2]; m = MONTHS[r[1].slice(0, 3).toLowerCase()]; d = 1; }
  else return null;
  y = +y; m = +m; d = +d;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "1,234.5 mi" -> 1234.5; blank -> null; garbage -> NaN.
export function parseNum(v) {
  const s = String(v ?? '').replace(/[,\s]|mi(les)?$|gal(lons)?$/gi, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// 64-bit FNV-1a, hex. Deterministic and sync (works in the browser and in node tests).
export function fnv1a(str) {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n, mask = 0xffffffffffffffffn;
  for (const b of new TextEncoder().encode(str)) { h ^= BigInt(b); h = (h * p) & mask; }
  return h.toString(16).padStart(16, '0');
}

// Hash of the normalized row content (not the raw text), so re-exports with different
// headers/column order/formatting of the same trip segment are still caught as duplicates.
export const rowHash = (r) => fnv1a(['eld1', r.entry_date, (r.truck_label || '').toLowerCase(), r.jurisdiction,
  r.miles, r.start_odometer ?? '', r.end_odometer ?? '', r.fuel_gallons ?? ''].join('|'));

// Validate + normalize. Returns [{ line, raw, value|null, errors: [] , duplicate }].
export function buildRows(rows, mapping) {
  const get = (r, k) => (mapping[k] >= 0 ? r[mapping[k]] ?? '' : '');
  const seen = new Set();
  return rows.map((r, i) => {
    const errors = [];
    const entry_date = parseDate(get(r, 'date'));
    if (!entry_date) errors.push(get(r, 'date') ? `Bad date "${get(r, 'date')}"` : 'Missing date');
    const jurisdiction = parseState(get(r, 'state'));
    if (!jurisdiction) errors.push(get(r, 'state') ? `Unknown state "${get(r, 'state')}"` : 'Missing state');
    const so = parseNum(get(r, 'start_odometer')), eo = parseNum(get(r, 'end_odometer'));
    let miles = parseNum(get(r, 'miles'));
    let start_odometer = null, end_odometer = null;
    if (Number.isNaN(so) || Number.isNaN(eo)) errors.push('Odometer is not a number');
    else if (so != null && eo != null) {
      if (eo < so) errors.push('End odometer is less than start');
      else {
        start_odometer = Math.round(so); end_odometer = Math.round(eo);
        const odoMiles = end_odometer - start_odometer;
        if (miles != null && !Number.isNaN(miles) && Math.abs(Math.round(miles) - odoMiles) > 1) errors.push(`Miles (${miles}) don't match odometer (${odoMiles})`);
        miles = odoMiles; // the DB trigger also sets miles = end - start
      }
    }
    if (Number.isNaN(miles)) errors.push('Miles is not a number');
    else if (miles == null) { if (!errors.length) errors.push('Missing miles (map Miles or both odometers)'); }
    else { miles = Math.round(miles); if (miles <= 0) errors.push('Miles must be greater than 0'); }
    let fuel_gallons = parseNum(get(r, 'fuel_gallons'));
    if (Number.isNaN(fuel_gallons) || (fuel_gallons != null && fuel_gallons < 0)) { errors.push('Bad fuel gallons'); fuel_gallons = null; }
    if (fuel_gallons != null) fuel_gallons = Math.round(fuel_gallons * 1000) / 1000;
    const truck_label = get(r, 'truck') || null;
    if (errors.length) return { line: i + 2, raw: r, value: null, errors, duplicate: false };
    const value = { entry_date, truck_label, jurisdiction, miles, start_odometer, end_odometer, fuel_gallons };
    value.import_hash = rowHash(value);
    const duplicate = seen.has(value.import_hash);
    seen.add(value.import_hash);
    return { line: i + 2, raw: r, value, errors: duplicate ? ['Duplicate of an earlier row in this file'] : [], duplicate };
  });
}

export const missingRequired = (mapping) => {
  const miss = FIELDS.filter((f) => f.required && !(mapping[f.key] >= 0)).map((f) => f.label);
  if (!(mapping.miles >= 0) && !(mapping.start_odometer >= 0 && mapping.end_odometer >= 0)) miss.push('Miles (or both odometers)');
  return miss;
};

// Rows for mileage_entries.insert(). source is free text by convention; 'eld' marks imports.
export const toInsertRows = (built, { userId, sourceName }) => built.filter((b) => b.value && !b.errors.length).map(({ value }) => ({
  user_id: userId, entry_date: value.entry_date, miles: value.miles,
  start_odometer: value.start_odometer, end_odometer: value.end_odometer,
  jurisdiction: value.jurisdiction, truck_label: value.truck_label, fuel_gallons: value.fuel_gallons,
  import_hash: value.import_hash, import_source: sourceName || null, source: 'eld',
  notes: `ELD import${sourceName ? ` (${sourceName})` : ''} · ${[value.truck_label, value.jurisdiction].filter(Boolean).join(' · ')}`,
}));
