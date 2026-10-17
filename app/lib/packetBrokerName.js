// Carrier packet G: guess the broker's company name from the packet's own text (uploads have no sender to go on).
// PURE, server-side (packetFingerprint uses node:crypto). Input: extractPdf pages ({ words:[{text,left,top}] , size }). Returns a display
// name or null. Our own company names (legal/DBA) are never returned.
import { pageLines, normalizeBrokerName } from './packetFingerprint.js';

const SUFFIX = /\b(?:llc|l\.l\.c\.?|inc\.?|incorporated|corp\.?|corporation|logistics|freight|brokerage|transportation|transport|express|trucking|solutions|company|co\.)$/i;
const LABELED = /\b(?:broker(?:age)?(?:\s+(?:company|legal|business))?(?:\s+name)?|brokerage\s+company|issued\s+by)\s*[:#–-]\s*(.+)$/i;
const QUOTED = /\bbroker(?:age)?\b[^"“”]{0,24}["“]([^"”]{2,60})["”]/i;
// Words that mean the "value" is really another label or a blank line.
const NOT_A_NAME = /^(?:_+|name|mc|dot|phone|email|address|date|signature|carrier|n\/?a|none)\b/i;

export function cleanName(s) {
  let v = String(s ?? '').replace(/_{2,}.*$/, '').replace(/\s{2,}.*$/, '').replace(/["“”]/g, '').replace(/[\s,.;:–-]+$/, '').replace(/^[\s,.;:–-]+/, '').trim();
  v = v.replace(/\s*\((?:fake|test)[^)]*\)\s*$/i, '').trim();
  if (v.length < 2 || v.length > 80 || !/\p{L}/u.test(v) || NOT_A_NAME.test(v)) return null;
  if (v.split(/\s+/).length > 8) return null;
  // ALL CAPS → Title Case ("ACME TEST LOGISTICS" → "Acme Test Logistics"); short tokens like LLC stay upper.
  if (v === v.toUpperCase() && /[A-Z]{3}/.test(v)) v = v.toLowerCase().replace(/\b\p{L}+/gu, (w) => (/^(llc|inc|usa|tql|ch)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return v;
}

export function detectBrokerName(pages = [], { ownNames = [] } = {}) {
  const own = new Set((ownNames || []).map(normalizeBrokerName).filter(Boolean));
  const ok = (v) => { const c = cleanName(v); const n = c && normalizeBrokerName(c); return c && n && !own.has(n) ? c : null; };
  const firstPages = (pages || []).slice(0, 2);
  // 1) "Broker: Acme Logistics" / "Broker Name - Acme Logistics" / "Issued by: …"
  for (const p of firstPages) for (const l of pageLines(p)) { const m = LABELED.exec(l.text); const v = m && ok(m[1]); if (v) return v; }
  // 2) a quoted name next to the word broker: FAKE BROKER "Acme Test Logistics"
  for (const p of firstPages) for (const l of pageLines(p)) { const m = QUOTED.exec(l.text); const v = m && ok(m[1]); if (v) return v; }
  // 3) a short line near the top of page 1 that ends in a company word (… Logistics, … LLC, … Freight Inc.)
  const p1 = (pages || [])[0];
  if (p1) {
    const H = p1.size?.[1] || Infinity;
    for (const l of pageLines(p1)) {
      if (l.top > H * 0.3) break;
      const t = l.text.trim();
      if (t.split(/\s+/).length <= 7 && SUFFIX.test(t)) { const v = ok(t); if (v) return v; }
    }
  }
  return null;
}
