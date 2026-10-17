// Carrier packet G (remember each broker's layout): PURE fingerprint, broker-identity and scoring helpers.
// No DB, no network, no routes. See docs/design/packet-layout-memory.md (§1 Matching). Input pages are the
// `extractPdf` output ({ page, size, sizePt, words:[{text}] }); output shapes match the packet_layouts.fingerprint
// jsonb: { v:1, pages:[{ w, h, text_hash, simhash, has_text }] }.
import { createHash } from 'node:crypto';

export const FINGERPRINT_VERSION = 1;
export const MIN_PAGE_CHARS = 20;      // normalized letters on a page below this = scanned/blank page
export const SIMHASH_MAX_DISTANCE = 6; // Hamming distance for a fuzzy page match
export const SIZE_TOLERANCE_PT = 1;
export const THRESHOLDS = { apply: 70, suggest: 45 };
export const POINTS = { exact: 60, fuzzy: 40, sizes: 10, mc: 25, mcConflict: -40, domain: 15, domainConflict: -10 };
export const PAGE_COUNT_WINDOW = 2;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// ---------- text fingerprint ----------
// Lowercase, digits removed (dates, load numbers and broker-prefilled values don't change the hash),
// punctuation and whitespace collapsed to single spaces.
export function normalizeText(s) {
  return String(s ?? '').toLowerCase().normalize('NFKC').replace(/\p{N}+/gu, '').replace(/[^\p{L}]+/gu, ' ').trim();
}
export const pageRawText = (page) => (page?.words || []).map((w) => String(w?.text ?? '')).join(' ');
export const textHash = (norm) => sha256(norm).slice(0, 16);

// Word 3-grams of normalized text (pages with fewer than 3 words use the words themselves).
export function shingles(norm) {
  const w = String(norm || '').split(' ').filter(Boolean);
  if (w.length < 3) return w;
  const out = [];
  for (let i = 0; i + 3 <= w.length; i++) out.push(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
const MASK64 = (1n << 64n) - 1n;
// 64-bit simhash as 16 lowercase hex chars (strings survive jsonb; BigInt doesn't). Empty text → null.
export function simhash(norm) {
  const sh = shingles(norm);
  if (!sh.length) return null;
  const v = new Array(64).fill(0);
  for (const s of sh) {
    const h = BigInt('0x' + sha256(s).slice(0, 16));
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return (out & MASK64).toString(16).padStart(16, '0');
}
export function hamming(a, b) {
  if (a == null || b == null) return Infinity;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { x &= x - 1n; n++; }
  return n;
}

// Page size in points, rounded to 1 pt. Prefers sizePt; falls back to raster px at `dpi`.
export function pageSizePt(page, dpi = 200) {
  const [w, h] = page?.sizePt || (page?.size ? page.size.map((v) => (v * 72) / dpi) : [0, 0]);
  return [Math.round(w || 0), Math.round(h || 0)];
}
export function pageFingerprint(page, opts = {}) {
  const norm = normalizeText(pageRawText(page));
  const [w, h] = pageSizePt(page, opts.dpi);
  const has_text = norm.replace(/ /g, '').length >= MIN_PAGE_CHARS;
  return { w, h, text_hash: has_text ? textHash(norm) : null, simhash: has_text ? simhash(norm) : null, has_text };
}
// layout_key = sha256 of the ordered per-page text hashes. Pages without text contribute `scan:WxH`, so two
// scans only share a key when every page size matches (scans are never auto-applied; see scoreLayout).
export function layoutKey(pages) {
  return sha256((pages || []).map((p) => (p.has_text && p.text_hash ? p.text_hash : `scan:${p.w}x${p.h}`)).join('\n'));
}
// extractPdf result → { fingerprint, layout_key, page_count, has_text }.
export function fingerprintPacket(ex, opts = {}) {
  const pages = (ex?.pages || []).map((p) => pageFingerprint(p, opts));
  return {
    fingerprint: { v: FINGERPRINT_VERSION, pages },
    layout_key: layoutKey(pages),
    page_count: ex?.pageCount ?? pages.length,
    has_text: pages.some((p) => p.has_text),
  };
}

// ---------- broker identity: MC ----------
// MC 0123456 / MC# 123456 / MC-123456 / MC: 123456 / MC No. 123456 / MC Number: 123456. Leading zeros dropped.
const MC_RE = /(?<![a-z0-9])MC(?:\s*(?:number|num|no)\.?)?[#:\s-]*0*(\d{4,8})(?!\d)/gi;
export function normalizeMc(v) {
  const m = /^\s*(?:MC)?[#:\s-]*0*(\d{1,8})\s*$/i.exec(String(v ?? ''));
  return m && m[1].length >= 4 ? m[1] : null;
}
// All MC numbers in the text except ours, most frequent first (ties: first seen).
export function findMcNumbers(text, { ownMc = null } = {}) {
  const own = normalizeMc(ownMc);
  const counts = new Map();
  for (const m of String(text ?? '').matchAll(MC_RE)) {
    if (m[1] === own) continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([mc, count]) => ({ mc, count }));
}
export function extractBrokerMc(pagesOrText, opts = {}) {
  const text = Array.isArray(pagesOrText) ? pagesOrText.map(pageRawText).join('\n') : pagesOrText;
  return findMcNumbers(text, opts)[0]?.mc || null;
}

// ---------- broker identity: email domain ----------
export const OWN_DOMAINS = ['fstrucks.com'];
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'hey.com', 'fastmail.com', 'comcast.net', 'att.net', 'sbcglobal.net',
  'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'frontier.com', 'windstream.net',
]);
// Country variants of the big providers: yahoo.co.uk, hotmail.fr, outlook.com.mx, live.ca, …
const FREE_MAIL_BRANDS = /^(?:yahoo|ymail|hotmail|outlook|live|gmail|aol|gmx|yandex|msn)\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/;

export function emailAddress(v) {
  const s = String(v ?? '').trim();
  const m = /mailto:([^\s<>"'\]\[,;]+@[^\s<>"'\]\[,;]+)/i.exec(s) || /<([^<>\s]+@[^<>\s]+)>/.exec(s) || /\[([^\[\]\s]+@[^\[\]\s]+)\]/.exec(s)
    || /([^\s<>"'\[\](),;:*]+@[^\s<>"'\[\](),;:*]+)/.exec(s);
  if (!m) return null;
  const e = m[1].toLowerCase().replace(/\.+$/, '');
  return /^[^@\s]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : null;
}
export const domainOfEmail = (email) => { const e = emailAddress(email); return e ? e.split('@')[1] : null; };
// Registrable part used for matching: mail.tql.com → tql.com, ops.broker.co.uk → broker.co.uk.
export function baseDomain(d) {
  const parts = String(d ?? '').toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.') || null;
  const sld = parts[parts.length - 2], tld = parts[parts.length - 1];
  const n = tld.length === 2 && /^(co|com|net|org|gov|ac|edu|ltd|plc)$/.test(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}
const ownDomainSet = (ownDomains = OWN_DOMAINS) => new Set([...OWN_DOMAINS, ...(ownDomains || [])].map((d) => baseDomain(d)).filter(Boolean));
export const isFreeMailDomain = (d) => { const b = baseDomain(d); return !!b && (FREE_MAIL_DOMAINS.has(b) || FREE_MAIL_DOMAINS.has(String(d).toLowerCase()) || FREE_MAIL_BRANDS.test(b)); };
export const isOwnDomain = (d, ownDomains) => { const b = baseDomain(d); return !!b && ownDomainSet(ownDomains).has(b); };
// The domain used for matching, or null for free mail, our own domains, and junk.
export function matchDomain(emailOrDomain, { ownDomains } = {}) {
  const raw = String(emailOrDomain ?? '').includes('@') ? domainOfEmail(emailOrDomain) : String(emailOrDomain ?? '').trim().toLowerCase();
  const b = baseDomain(raw);
  if (!b || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(b)) return null;
  if (isFreeMailDomain(raw) || isOwnDomain(raw, ownDomains)) return null;
  return b;
}

// ---------- forwarded From: parser ----------
const FWD_HEADER = /^(?:date|sent|to|cc|subject)\s*:/i;
// "From:" lines in a plain-text body (Gmail "---------- Forwarded message ---------", Outlook "From: … Sent: …",
// Apple Mail "Begin forwarded message:", quoted "> From:", Outlook's "*From:*" bold). A From: only counts when a
// Date/Sent/To/Cc/Subject header follows within the next 4 non-empty lines, so "From: Chicago, IL" in a load
// description is ignored. Returns addresses top to bottom.
export function forwardedFromAddresses(textBody) {
  const lines = String(textBody ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^[\s>]+/, '').replace(/\*/g, '').trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:from|de|von)\s*:\s*(.+)$/i.exec(lines[i]);
    if (!m) continue;
    const next = lines.slice(i + 1).filter(Boolean).slice(0, 4);
    if (!next.some((l) => FWD_HEADER.test(l))) continue;
    const e = emailAddress(m[1]);
    if (e) out.push(e);
  }
  return out;
}
// The original sender of a (possibly forwarded) inbound email. Our own users and domains are skipped.
// Order: first forwarded From: that isn't ours → Reply-To → From. The full address is kept even for free mail;
// `domain` is the matchable domain (null for free mail / ours).
export function brokerSender({ textBody, replyTo, from, ourEmails = [], ownDomains } = {}) {
  const ours = new Set((ourEmails || []).map((e) => emailAddress(e)).filter(Boolean));
  const isOurs = (e) => !e || ours.has(e) || isOwnDomain(e.split('@')[1], ownDomains);
  const pick = (email, source) => ({ email, domain: matchDomain(email, { ownDomains }), source });
  for (const e of forwardedFromAddresses(textBody)) if (!isOurs(e)) return pick(e, 'forwarded');
  const rt = emailAddress(replyTo); if (rt && !isOurs(rt)) return pick(rt, 'reply_to');
  const fr = emailAddress(from); if (fr && !isOurs(fr)) return pick(fr, 'from');
  return { email: null, domain: null, source: null };
}

// ---------- page mapping + scoring ----------
// Template pages → packet pages, one-to-one: exact text_hash first, then nearest simhash within the distance.
// Only text pages are mapped. Returns { pairs:[{template, packet, how, distance}], unmatchedTemplate, unmatchedPacket }.
export function mapPages(templatePages = [], packetPages = [], { maxDistance = SIMHASH_MAX_DISTANCE } = {}) {
  const used = new Set(), pairs = [], tDone = new Set();
  templatePages.forEach((t, ti) => {
    if (!t?.has_text || !t.text_hash) return;
    const pi = packetPages.findIndex((p, j) => !used.has(j) && p?.has_text && p.text_hash === t.text_hash);
    if (pi >= 0) { used.add(pi); tDone.add(ti); pairs.push({ template: ti, packet: pi, how: 'hash', distance: 0 }); }
  });
  templatePages.forEach((t, ti) => {
    if (tDone.has(ti) || !t?.has_text || !t.simhash) return;
    let best = -1, bd = Infinity;
    packetPages.forEach((p, j) => {
      if (used.has(j) || !p?.has_text) return;
      const d = hamming(t.simhash, p.simhash);
      if (d < bd || (d === bd && Math.abs(j - ti) < Math.abs(best - ti))) { bd = d; best = j; }
    });
    if (best >= 0 && bd <= maxDistance) { used.add(best); tDone.add(ti); pairs.push({ template: ti, packet: best, how: 'simhash', distance: bd }); }
  });
  pairs.sort((a, b) => a.template - b.template);
  return {
    pairs,
    unmatchedTemplate: templatePages.map((_, i) => i).filter((i) => !tDone.has(i)),
    unmatchedPacket: packetPages.map((_, j) => j).filter((j) => !used.has(j)),
  };
}
// Share of the template's text pages that found a packet page (0..1). No text pages → 0.
export function fuzzyShare(templatePages = [], packetPages = [], opts) {
  const n = templatePages.filter((t) => t?.has_text && t.simhash).length;
  return n ? mapPages(templatePages, packetPages, opts).pairs.length / n : 0;
}
export function sizesEqual(a = [], b = [], tol = SIZE_TOLERANCE_PT) {
  return a.length === b.length && a.length > 0 && a.every((p, i) => Math.abs(p.w - b[i].w) <= tol && Math.abs(p.h - b[i].h) <= tol);
}
// Layout candidates for a packet: page_count within ±2, or same MC, or same domain.
export function isCandidate(packet, layout) {
  if (!layout || (layout.status && layout.status !== 'active')) return false;
  const mc = normalizeMc(packet?.broker_mc), lmc = normalizeMc(layout.broker_mc);
  if (mc && lmc && mc === lmc) return true;
  if (packet?.broker_domain && layout.broker_domain && packet.broker_domain === layout.broker_domain) return true;
  return Math.abs((packet?.page_count ?? 0) - (layout.page_count ?? 0)) <= PAGE_COUNT_WINDOW;
}

// Score one saved layout against one packet. Both sides: { fingerprint:{pages}, layout_key, page_count, broker_mc, broker_domain }.
// decision: 'apply' | 'suggest' | 'changed' (broker's form changed: detect fresh, show notice) | 'none'.
// Precedence (design §1 fallback order + thresholds):
//   scanned (either side has no text page) → suggest if score ≥ 45, never apply;
//   MC conflict → never apply (suggest if ≥ 45);
//   1 exact layout_key → apply; 2 MC + fuzzy ≥ 0.8 → apply; 3 domain + fuzzy ≥ 0.8 → apply;
//   5 MC/domain match + fuzzy < 0.5 → changed; otherwise ≥ 70 apply, ≥ 45 suggest (covers 4: fuzzy ≥ 0.9 alone = suggest).
export function scoreLayout(packet, layout) {
  const pp = packet?.fingerprint?.pages || [], tp = layout?.fingerprint?.pages || [];
  const packetText = pp.some((p) => p?.has_text), templateText = tp.some((p) => p?.has_text);
  const scanned = !packetText || !templateText;
  const exact = !scanned && !!packet?.layout_key && packet.layout_key === layout?.layout_key;
  const fuzzy = scanned ? 0 : exact ? 1 : fuzzyShare(tp, pp);
  const sizes = (packet?.page_count ?? pp.length) === (layout?.page_count ?? tp.length) && sizesEqual(pp, tp);
  const mc = normalizeMc(packet?.broker_mc), lmc = normalizeMc(layout?.broker_mc);
  const mcMatch = !!mc && mc === lmc, mcConflict = !!mc && !!lmc && mc !== lmc;
  const dom = packet?.broker_domain || null, ldom = layout?.broker_domain || null;
  const domainMatch = !!dom && dom === ldom, domainConflict = !!dom && !!ldom && dom !== ldom;
  const parts = {
    exact: exact ? POINTS.exact : 0,
    fuzzy: Math.round(POINTS.fuzzy * fuzzy * 10) / 10,
    sizes: sizes ? POINTS.sizes : 0,
    mc: mcMatch ? POINTS.mc : mcConflict ? POINTS.mcConflict : 0,
    domain: domainMatch ? POINTS.domain : domainConflict ? POINTS.domainConflict : 0,
  };
  const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 10) / 10;
  const band = score >= THRESHOLDS.apply ? 'apply' : score >= THRESHOLDS.suggest ? 'suggest' : 'none';
  let decision, reason;
  if (scanned) { decision = score >= THRESHOLDS.suggest ? 'suggest' : 'none'; reason = 'scanned'; }
  else if (mcConflict) { decision = score >= THRESHOLDS.suggest ? 'suggest' : 'none'; reason = 'mc_conflict'; }
  else if (exact) { decision = 'apply'; reason = 'exact'; }
  else if (mcMatch && fuzzy >= 0.8) { decision = 'apply'; reason = 'mc_fuzzy'; }
  else if (domainMatch && fuzzy >= 0.8) { decision = 'apply'; reason = 'domain_fuzzy'; }
  else if ((mcMatch || domainMatch) && fuzzy < 0.5) { decision = 'changed'; reason = 'form_changed'; }
  else if (band === 'apply') { decision = 'apply'; reason = 'score'; }
  else if (fuzzy >= 0.9 && band !== 'none') { decision = 'suggest'; reason = 'fuzzy_only'; }
  else { decision = band; reason = 'score'; }
  return { score, decision, reason, parts, exact, fuzzy, sizesEqual: sizes, mcMatch, mcConflict, domainMatch, domainConflict, scanned };
}

const RANK = { apply: 3, suggest: 2, changed: 1, none: 0 };
// Best layout for a packet among candidates: highest decision first, then score, then most recently used.
// Returns { layout, result } or null when nothing reaches suggest/changed.
export function pickLayout(packet, layouts = []) {
  const scored = layouts.filter((l) => isCandidate(packet, l)).map((layout) => ({ layout, result: scoreLayout(packet, layout) }))
    .filter((x) => x.result.decision !== 'none');
  scored.sort((a, b) => RANK[b.result.decision] - RANK[a.result.decision] || b.result.score - a.result.score
    || String(b.layout.last_used_at || '').localeCompare(String(a.layout.last_used_at || '')));
  return scored[0] || null;
}
