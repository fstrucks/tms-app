import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdf } from '../../app/lib/packetPdfText.js';
import {
  normalizeText, textHash, shingles, simhash, hamming, pageSizePt, pageFingerprint, layoutKey, fingerprintPacket,
  normalizeMc, findMcNumbers, extractBrokerMc, emailAddress, domainOfEmail, baseDomain, isFreeMailDomain, isOwnDomain,
  matchDomain, forwardedFromAddresses, brokerSender, mapPages, fuzzyShare, sizesEqual, isCandidate, scoreLayout, pickLayout,
  THRESHOLDS, POINTS, MIN_PAGE_CHARS,
} from '../../app/lib/packetFingerprint.js';

// Fake broker form text only (no real companies, MCs or people).
const WORDS = ('acme test logistics carrier setup agreement the carrier agrees to haul freight tendered by broker under the terms below '
  + 'carrier legal name dba name mc number dot number physical address city state zip phone email dispatcher contact '
  + 'insurance cargo liability limits auto liability general liability certificate holder must list broker as additional insured '
  + 'payment terms quick pay option factoring company remit to name remit address bank routing account number w nine attached '
  + 'carrier shall not double broker re broker or co broker any load detention layover lumper fees require prior approval '
  + 'tracking updates every four hours via app or phone failure to provide updates may result in fines claims procedure seal '
  + 'numbers pod within twenty four hours accessorials must be on the rate confirmation to be paid hazmat requires endorsement').split(' ');
const formText = (seed = 0, n = 240) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + seed * 13) % WORDS.length]).join(' ');
const page = (text, sizePt = [612, 792], n = 1) => ({ page: n, sizePt, size: sizePt.map((v) => (v * 200) / 72), words: String(text).split(/\s+/).filter(Boolean).map((t) => ({ text: t })) });
const fp = (pages, extra = {}) => { const f = fingerprintPacket({ pages, pageCount: pages.length }); return { ...f, ...extra }; };

// ---------- normalization + hashes ----------
test('normalizeText: lowercase, digits removed, punctuation/whitespace collapsed', () => {
  assert.equal(normalizeText('  Load #12345 — Pickup: 10/17/2026, 8:00 AM\n\tACME  Test '), 'load pickup am acme test');
  assert.equal(normalizeText('MC-0123456'), 'mc');
  assert.equal(normalizeText('Café   Señor'), 'café señor');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText('123 456 !!'), '');
});
test('textHash: 16 hex chars, stable, ignores digits/punctuation differences', () => {
  const a = textHash(normalizeText('Rate: $1,200 Load 55501 Date 10/17/2026'));
  const b = textHash(normalizeText('rate $ load date - 2026-10-18 load#99'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, textHash(normalizeText('Rate Load Date')));
  assert.notEqual(a, b); // "load" appears twice in b
});
test('shingles: word 3-grams, short text falls back to words', () => {
  assert.deepEqual(shingles('a b c d'), ['a b c', 'b c d']);
  assert.deepEqual(shingles('a b'), ['a', 'b']);
  assert.deepEqual(shingles(''), []);
});
test('simhash: 64-bit hex, deterministic, null for empty', () => {
  const t = normalizeText(formText());
  const s = simhash(t);
  assert.match(s, /^[0-9a-f]{16}$/);
  assert.equal(s, simhash(t));
  assert.equal(simhash(''), null);
});
test('hamming: bit distance, null → Infinity', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming('000000000000000f', '0000000000000001'), 3);
  assert.equal(hamming(null, '00'), Infinity);
});
test('simhash: a tweaked line stays within 6 bits, a different form does not', () => {
  const base = formText(0, 300).split(' ');
  const tweaked = [...base]; tweaked.splice(100, 3, 'revised', 'wording', 'here');
  const d1 = hamming(simhash(normalizeText(base.join(' '))), simhash(normalizeText(tweaked.join(' '))));
  assert.ok(d1 <= 6, `tweak distance ${d1}`);
  const other = 'bill of lading shipper consignee pieces weight class nmfc description of articles special instructions '.repeat(20);
  const d2 = hamming(simhash(normalizeText(base.join(' '))), simhash(normalizeText(other)));
  assert.ok(d2 > 12, `different form distance ${d2}`);
  // Only digits changed → identical simhash.
  const withNums = base.map((w, i) => (i % 25 === 0 ? `${w} ${i * 31}` : w)).join(' ');
  assert.equal(hamming(simhash(normalizeText(base.join(' '))), simhash(normalizeText(withNums))), 0);
});

// ---------- per-page + overall fingerprint ----------
test('pageSizePt: rounds sizePt, falls back to raster px at 200 dpi', () => {
  assert.deepEqual(pageSizePt({ sizePt: [612.4, 791.6] }), [612, 792]);
  assert.deepEqual(pageSizePt({ size: [1700, 2200] }), [612, 792]);
  assert.deepEqual(pageSizePt({}), [0, 0]);
});
test('pageFingerprint: text page vs scanned page', () => {
  const t = pageFingerprint(page(formText()));
  assert.deepEqual(Object.keys(t).sort(), ['h', 'has_text', 'head', 'simhash', 'text_hash', 'w']);
  assert.match(t.head, /^[0-9a-f]{8}( [0-9a-f]{8}){15}$/); // 16 hashed head words, never the words
  assert.equal(t.has_text, true); assert.match(t.text_hash, /^[0-9a-f]{16}$/); assert.match(t.simhash, /^[0-9a-f]{16}$/);
  const scan = pageFingerprint(page('12 34 5 / . x'));
  assert.deepEqual(scan, { w: 612, h: 792, text_hash: null, simhash: null, has_text: false, head: null });
  assert.equal(pageFingerprint(page('a'.repeat(MIN_PAGE_CHARS))).has_text, true);
  assert.equal(pageFingerprint(page('a'.repeat(MIN_PAGE_CHARS - 1))).has_text, false);
});
test('fingerprintPacket: same form with different dates/load numbers → same layout_key', () => {
  const a = fingerprintPacket({ pageCount: 2, pages: [page(formText(0) + ' load 1001 date 10/01/2026'), page(formText(1), [612, 792], 2)] });
  const b = fingerprintPacket({ pageCount: 2, pages: [page(formText(0) + ' load 88231 date 11/30/2026'), page(formText(1), [612, 792], 2)] });
  assert.equal(a.layout_key, b.layout_key);
  assert.match(a.layout_key, /^[0-9a-f]{64}$/);
  assert.equal(a.fingerprint.v, 2); assert.equal(a.page_count, 2); assert.equal(a.has_text, true);
  const swapped = fingerprintPacket({ pageCount: 2, pages: [page(formText(1)), page(formText(0) + ' load date')] });
  assert.notEqual(swapped.layout_key, a.layout_key); // order matters for the exact key
});
test('layoutKey: scanned pages keyed by size, so different-size scans differ', () => {
  const s1 = layoutKey([{ w: 612, h: 792, has_text: false }]), s2 = layoutKey([{ w: 612, h: 1008, has_text: false }]);
  assert.notEqual(s1, s2);
  assert.equal(s1, layoutKey([{ w: 612, h: 792, has_text: false, text_hash: null }]));
});
test('fingerprint never contains page text', () => {
  const f = fingerprintPacket({ pages: [page('Secret routing 021000021 account 123456789 ' + formText())] });
  const s = JSON.stringify(f);
  for (const w of ['secret', 'routing', '021000021', '123456789', 'carrier']) assert.ok(!s.toLowerCase().includes(w), w);
});

// ---------- MC extraction ----------
test('normalizeMc: prefixes and leading zeros', () => {
  assert.equal(normalizeMc('MC-0123456'), '123456');
  assert.equal(normalizeMc('mc# 001234'), '1234');
  assert.equal(normalizeMc('123456'), '123456');
  assert.equal(normalizeMc('12'), null);
  assert.equal(normalizeMc(''), null);
  assert.equal(normalizeMc('abc'), null);
});
test('findMcNumbers: formats, skips our MC, most frequent first', () => {
  const text = 'Broker MC# 0654321 ... Acme Test Logistics MC 654321 ... Carrier MC: 111222 ... MC-654321 ... MC No. 777888 ... MC Number: 999000';
  assert.deepEqual(findMcNumbers(text, { ownMc: 'MC-111222' }), [{ mc: '654321', count: 3 }, { mc: '777888', count: 1 }, { mc: '999000', count: 1 }]);
  assert.equal(extractBrokerMc(text, { ownMc: '111222' }), '654321');
});
test('findMcNumbers: ignores blanks, words containing mc, too-long numbers', () => {
  assert.deepEqual(findMcNumbers('MC number: ________  DOT: _______'), []);
  assert.deepEqual(findMcNumbers('SMC 123456  amc4567 McDonald 12345'), []);
  assert.deepEqual(findMcNumbers('MC 1234567890'), []);
  assert.equal(extractBrokerMc('MC 12345678'), '12345678');
  assert.equal(extractBrokerMc('mc123456'), '123456');
});
test('extractBrokerMc: only our own MC printed → null; reads extractPdf pages', () => {
  assert.equal(extractBrokerMc('Carrier MC 0111222 MC 111222', { ownMc: '111222' }), null);
  assert.equal(extractBrokerMc([page('Broker: Acme Test MC # 445566'), page('Carrier MC 111222')], { ownMc: '111222' }), '445566');
  assert.equal(extractBrokerMc(''), null);
  assert.equal(extractBrokerMc([], {}), null);
});
test('extractBrokerMc: tie goes to the first one seen', () => {
  assert.equal(extractBrokerMc('MC 5555 then MC 4444'), '5555');
});

// ---------- domains ----------
test('emailAddress: display names, angle brackets, mailto, junk', () => {
  assert.equal(emailAddress('Jane Broker <Jane.B@Acme-Test.example>'), 'jane.b@acme-test.example');
  assert.equal(emailAddress('Jane Broker [mailto:jane@acmetest.com]'), 'jane@acmetest.com');
  assert.equal(emailAddress('"Broker, Jane" <jane@acmetest.com>'), 'jane@acmetest.com');
  assert.equal(emailAddress('jane@acmetest.com.'), 'jane@acmetest.com');
  assert.equal(emailAddress('no email here'), null);
  assert.equal(emailAddress('bad@nodot'), null);
  assert.equal(emailAddress(null), null);
});
test('baseDomain: strips subdomains, keeps co.uk style', () => {
  assert.equal(baseDomain('mail.acmetest.com'), 'acmetest.com');
  assert.equal(baseDomain('ops.broker.co.uk'), 'broker.co.uk');
  assert.equal(baseDomain('acmetest.com'), 'acmetest.com');
  assert.equal(baseDomain(''), null);
});
test('free mail and own domains are not used for matching', () => {
  for (const d of ['gmail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.fr', 'outlook.com', 'outlook.com.mx', 'icloud.com', 'aol.com', 'comcast.net', 'proton.me'])
    assert.equal(isFreeMailDomain(d), true, d);
  assert.equal(isFreeMailDomain('acmetest.com'), false);
  assert.equal(isOwnDomain('fstrucks.com'), true);
  assert.equal(isOwnDomain('in.fstrucks.com'), true);
  assert.equal(isOwnDomain('othertrucks.com', ['othertrucks.com']), true);
  assert.equal(matchDomain('dispatch@gmail.com'), null);
  assert.equal(matchDomain('marc@fstrucks.com'), null);
  assert.equal(matchDomain('packets@in.fstrucks.com'), null);
  assert.equal(matchDomain('jane@mail.acmetest.com'), 'acmetest.com');
  assert.equal(matchDomain('acmetest.com'), 'acmetest.com');
  assert.equal(matchDomain('carrier@ourfleet.com', { ownDomains: ['ourfleet.com'] }), null);
  assert.equal(matchDomain('garbage'), null);
  assert.equal(domainOfEmail('Jane <jane@Acmetest.com>'), 'acmetest.com');
  // Matchable domains fit the packet_layouts.broker_domain check.
  assert.match(matchDomain('x@sub.acme-test.co.uk'), /^[a-z0-9.-]+\.[a-z]{2,}$/);
});

// ---------- forwarded From: ----------
const GMAIL_FWD = `Please set us up.\n\n---------- Forwarded message ---------\nFrom: Jane Broker <jane@acmetest.com>\nDate: Fri, Oct 16, 2026 at 3:12 PM\nSubject: Carrier packet\nTo: <marc@fstrucks.com>\n\nAttached is our packet.`;
const OUTLOOK_FWD = `FYI\r\n\r\n________________________________\r\nFrom: Jane Broker <jane@acmetest.com>\r\nSent: Friday, October 16, 2026 3:12 PM\r\nTo: Marc <marc@fstrucks.com>\r\nSubject: Carrier packet\r\n`;
const OUTLOOK_MAILTO = `-----Original Message-----\n*From:* Jane Broker [mailto:jane@acmetest.com]\n*Sent:* Friday, October 16, 2026 3:12 PM\n*To:* Marc\n`;
const APPLE_FWD = `Begin forwarded message:\n\nFrom: Jane Broker <jane@acmetest.com>\nSubject: Carrier packet\nDate: October 16, 2026 at 3:12:00 PM PDT\nTo: marc@fstrucks.com\n`;
const QUOTED = `> ---------- Forwarded message ---------\n> From: jane@acmetest.com\n> Date: Fri, Oct 16, 2026\n> To: marc@fstrucks.com\n`;
test('forwardedFromAddresses: Gmail, Outlook, Outlook mailto/bold, Apple Mail, quoted', () => {
  for (const [name, body] of Object.entries({ GMAIL_FWD, OUTLOOK_FWD, OUTLOOK_MAILTO, APPLE_FWD, QUOTED }))
    assert.deepEqual(forwardedFromAddresses(body), ['jane@acmetest.com'], name);
});
test('forwardedFromAddresses: ignores From: lines that are not headers', () => {
  assert.deepEqual(forwardedFromAddresses('Load details\nFrom: Chicago, IL\nTo: Dallas, TX\nWeight 40000'), []); // no email
  assert.deepEqual(forwardedFromAddresses('Note from: jane@acmetest.com about rates\nthanks\nbye'), []);
  assert.deepEqual(forwardedFromAddresses('From: jane@acmetest.com\n\nplain body with no headers after\nline\nline\nline\nSubject: later'), []);
  assert.deepEqual(forwardedFromAddresses(''), []);
  assert.deepEqual(forwardedFromAddresses(null), []);
});
test('brokerSender: forwarded broker wins over our forwarder', () => {
  const r = brokerSender({ textBody: GMAIL_FWD, from: 'Marc <marc@fstrucks.com>', ourEmails: ['marc@fstrucks.com'] });
  assert.deepEqual(r, { email: 'jane@acmetest.com', domain: 'acmetest.com', source: 'forwarded' });
});
test('brokerSender: double forward skips our dispatcher (even on free mail) and finds the broker', () => {
  const body = `---------- Forwarded message ---------\nFrom: Dispatch <ourdispatch@gmail.com>\nDate: Fri\nTo: marc@fstrucks.com\n\n${GMAIL_FWD}`;
  const r = brokerSender({ textBody: body, from: 'ourdispatch@gmail.com', ourEmails: ['ourdispatch@gmail.com', 'MARC@fstrucks.com'] });
  assert.equal(r.email, 'jane@acmetest.com'); assert.equal(r.source, 'forwarded');
});
test('brokerSender: falls back to Reply-To, then From, only if not ours', () => {
  assert.deepEqual(brokerSender({ textBody: 'no forward', replyTo: 'setup@acmetest.com', from: 'marc@fstrucks.com' }), { email: 'setup@acmetest.com', domain: 'acmetest.com', source: 'reply_to' });
  assert.deepEqual(brokerSender({ textBody: '', replyTo: 'marc@fstrucks.com', from: 'Broker <b@acmetest.com>' }), { email: 'b@acmetest.com', domain: 'acmetest.com', source: 'from' });
  assert.deepEqual(brokerSender({ textBody: '', from: 'marc@fstrucks.com' }), { email: null, domain: null, source: null });
  assert.deepEqual(brokerSender({ from: 'dispatch@gmail.com', ourEmails: ['dispatch@gmail.com'] }), { email: null, domain: null, source: null });
  assert.deepEqual(brokerSender(), { email: null, domain: null, source: null });
});
test('brokerSender: free-mail broker keeps the address but has no match domain', () => {
  const body = GMAIL_FWD.replace('jane@acmetest.com', 'smallbroker@yahoo.com');
  assert.deepEqual(brokerSender({ textBody: body, ourEmails: ['marc@fstrucks.com'] }), { email: 'smallbroker@yahoo.com', domain: null, source: 'forwarded' });
});

// ---------- page mapping ----------
test('mapPages: exact hash, then simhash; extra and reordered pages', () => {
  const A = formText(0, 300), B = formText(3, 300), W9 = 'request for taxpayer identification number and certification '.repeat(10);
  const tpl = fp([page(A), page(B)]).fingerprint.pages;
  const bTweak = B.split(' '); bTweak.splice(50, 2, 'new', 'clause');
  const pkt = fp([page(W9), page(bTweak.join(' ')), page(A)]).fingerprint.pages;
  const m = mapPages(tpl, pkt);
  assert.deepEqual(m.pairs.map(({ template, packet, how }) => [template, packet, how]), [[0, 2, 'hash'], [1, 1, 'simhash']]);
  assert.ok(m.pairs[1].distance <= 6);
  assert.deepEqual(m.unmatchedTemplate, []); assert.deepEqual(m.unmatchedPacket, [0]);
  assert.equal(fuzzyShare(tpl, pkt), 1);
});
test('mapPages: one-to-one (duplicate pages are not double-counted) and scans never map', () => {
  const A = formText(0, 300);
  const tpl = fp([page(A), page(A)]).fingerprint.pages, pkt = fp([page(A)]).fingerprint.pages;
  assert.equal(mapPages(tpl, pkt).pairs.length, 1);
  assert.equal(fuzzyShare(tpl, pkt), 0.5);
  const scan = [{ w: 612, h: 792, has_text: false, text_hash: null, simhash: null }];
  assert.deepEqual(mapPages(scan, scan).pairs, []);
  assert.equal(fuzzyShare(scan, scan), 0);
  assert.equal(fuzzyShare([], []), 0);
});
test('sizesEqual: within 1 pt, same length', () => {
  assert.equal(sizesEqual([{ w: 612, h: 792 }], [{ w: 613, h: 791 }]), true);
  assert.equal(sizesEqual([{ w: 612, h: 792 }], [{ w: 612, h: 1008 }]), false);
  assert.equal(sizesEqual([{ w: 612, h: 792 }], [{ w: 612, h: 792 }, { w: 612, h: 792 }]), false);
  assert.equal(sizesEqual([], []), false);
});

// ---------- scoring ----------
const A = formText(0, 300), B = formText(3, 300), C = formText(5, 300);
const tweak = (t, at = 60) => { const w = t.split(' '); w.splice(at, 2, 'revised', 'clause'); return w.join(' '); };
const tpl = (extra = {}) => ({ ...fp([page(A), page(B), page(C)]), status: 'active', ...extra });
const pkt = (pages = [page(A), page(B), page(C)], extra = {}) => fp(pages, extra);
const OTHER = 'bill of lading shipper consignee pieces weight class nmfc description of articles '.repeat(25);
const OTHER2 = 'driver qualification file road test certificate annual review of driving record '.repeat(25);

test('points and thresholds match the design note', () => {
  assert.deepEqual(THRESHOLDS, { apply: 70, suggest: 45 });
  assert.deepEqual(POINTS, { exact: 60, fuzzy: 40, sizes: 10, mc: 25, mcConflict: -40, domain: 15, domainConflict: -10, name: 15 });
});
test('1. exact layout_key, no MC conflict → apply (110 points)', () => {
  const r = scoreLayout(pkt(), tpl());
  assert.equal(r.decision, 'apply'); assert.equal(r.reason, 'exact'); assert.equal(r.score, 110);
  assert.deepEqual(r.parts, { exact: 60, fuzzy: 40, sizes: 10, mc: 0, domain: 0, name: 0 });
  const r2 = scoreLayout(pkt(undefined, { broker_mc: '445566', broker_domain: 'acmetest.com' }), tpl({ broker_mc: '445566', broker_domain: 'acmetest.com' }));
  assert.equal(r2.score, 150); assert.equal(r2.decision, 'apply');
});
test('exact match but MC conflict → vetoed to suggest', () => {
  const r = scoreLayout(pkt(undefined, { broker_mc: '111111' }), tpl({ broker_mc: '222222' }));
  assert.equal(r.mcConflict, true); assert.equal(r.score, 70); assert.equal(r.decision, 'suggest'); assert.equal(r.reason, 'mc_conflict');
});
test('MC conflict on a weak match → none', () => {
  const r = scoreLayout(pkt([page(OTHER)], { broker_mc: '111111' }), tpl({ broker_mc: '222222' }));
  assert.equal(r.decision, 'none'); assert.ok(r.score < 0);
});
test('2. MC match + fuzzy ≥ 0.8 → apply even below 70 points', () => {
  const p = pkt([page(tweak(A)), page(tweak(B)), page(tweak(C))], { broker_mc: '445566' });
  const r = scoreLayout(p, tpl({ broker_mc: 'MC-0445566' }));
  assert.equal(r.exact, false); assert.equal(r.fuzzy, 1); assert.equal(r.mcMatch, true);
  assert.equal(r.score, 75); assert.equal(r.decision, 'apply');
  // 4 of 5 pages fuzzy-matching (0.8), sizes differ: 32 + 25 = 57 points, still applies by rule 2.
  const D = formText(7, 300), E = formText(9, 300);
  const t5 = { ...fp([page(A), page(B), page(C), page(D), page(E)]), broker_mc: '445566' };
  const p5 = fp([page(tweak(A)), page(tweak(B)), page(tweak(C)), page(tweak(D)), page(OTHER, [612, 1008])], { broker_mc: '445566' });
  const r5 = scoreLayout(p5, t5);
  assert.equal(r5.fuzzy, 0.8); assert.equal(r5.score, 57); assert.equal(r5.decision, 'apply'); assert.equal(r5.reason, 'mc_fuzzy');
});
test('3. domain match + fuzzy ≥ 0.8 → apply', () => {
  const p = pkt([page(tweak(A)), page(tweak(B)), page(tweak(C))], { broker_domain: 'acmetest.com' });
  const r = scoreLayout(p, tpl({ broker_domain: 'acmetest.com' }));
  assert.equal(r.score, 65); assert.equal(r.decision, 'apply'); assert.equal(r.reason, 'domain_fuzzy');
});
test('4. fuzzy alone (≥ 0.9, no identity) → suggest only', () => {
  const r = scoreLayout(pkt([page(tweak(A)), page(tweak(B)), page(tweak(C))]), tpl());
  assert.equal(r.fuzzy, 1); assert.equal(r.score, 50); assert.equal(r.decision, 'suggest'); assert.equal(r.reason, 'fuzzy_only');
});
test('5. MC/domain match but fingerprint < 0.5 → changed (detect fresh)', () => {
  const r = scoreLayout(pkt([page(OTHER), page(OTHER2), page(C)], { broker_mc: '445566', broker_domain: 'acmetest.com' }), tpl({ broker_mc: '445566', broker_domain: 'acmetest.com' }));
  assert.ok(r.fuzzy < 0.5); assert.equal(r.decision, 'changed'); assert.equal(r.reason, 'form_changed');
  const r2 = scoreLayout(pkt([page(OTHER)], { broker_domain: 'acmetest.com' }), tpl({ broker_domain: 'acmetest.com' }));
  assert.equal(r2.decision, 'changed');
});
test('6. scanned packets: never auto-apply; suggest with size + identity', () => {
  const scanPages = [page(''), page(''), page('')];
  const t = { ...fp(scanPages), broker_mc: '445566', broker_domain: 'acmetest.com' };
  const p = fp(scanPages, { broker_mc: '445566', broker_domain: 'acmetest.com' });
  assert.equal(p.layout_key, t.layout_key); // same sizes → same key, but that is not an "exact" text match
  const r = scoreLayout(p, t);
  assert.equal(r.scanned, true); assert.equal(r.exact, false); assert.equal(r.score, 50); assert.equal(r.decision, 'suggest'); assert.equal(r.reason, 'scanned');
  const r2 = scoreLayout(fp(scanPages, { broker_domain: 'acmetest.com' }), t);
  assert.equal(r2.score, 25); assert.equal(r2.decision, 'none');
  const r3 = scoreLayout(fp(scanPages), tpl()); // text template vs scanned packet
  assert.equal(r3.scanned, true); assert.equal(r3.decision, 'none');
});
test('mid fuzzy (0.5–0.8) with MC → suggest by score band', () => {
  const t = { ...fp([page(A), page(B)]), broker_mc: '445566' };
  const r = scoreLayout(fp([page(tweak(A)), page(OTHER)], { broker_mc: '445566' }), t);
  assert.equal(r.fuzzy, 0.5); assert.equal(r.score, 55); assert.equal(r.decision, 'suggest'); assert.equal(r.reason, 'score');
});
test('domain conflict costs 10 and blocks the domain rule', () => {
  const p = pkt([page(tweak(A)), page(tweak(B)), page(tweak(C))], { broker_domain: 'other-test.com' });
  const r = scoreLayout(p, tpl({ broker_domain: 'acmetest.com' }));
  assert.equal(r.domainConflict, true); assert.equal(r.score, 40); assert.equal(r.decision, 'none');
});
test('unrelated form, no identity → none', () => {
  const r = scoreLayout(pkt([page(OTHER), page(OTHER2), page(OTHER)]), tpl());
  assert.equal(r.decision, 'none'); assert.equal(r.score, 10);
});
test('upload (no domain) never gets a domain penalty', () => {
  const r = scoreLayout(pkt(), tpl({ broker_domain: 'acmetest.com' }));
  assert.equal(r.parts.domain, 0); assert.equal(r.decision, 'apply');
});
test('scoreLayout tolerates missing inputs', () => {
  const r = scoreLayout(undefined, undefined);
  assert.equal(r.decision, 'none'); assert.equal(r.score, 0);
});

// ---------- candidates + picking ----------
test('isCandidate: page count ±2, or same MC/domain, active only', () => {
  const p = { page_count: 5, broker_mc: '445566', broker_domain: 'acmetest.com' };
  assert.equal(isCandidate(p, { page_count: 7 }), true);
  assert.equal(isCandidate(p, { page_count: 8 }), false);
  assert.equal(isCandidate(p, { page_count: 20, broker_mc: '0445566' }), true);
  assert.equal(isCandidate(p, { page_count: 20, broker_domain: 'acmetest.com' }), true);
  assert.equal(isCandidate(p, { page_count: 5, status: 'superseded' }), false);
  assert.equal(isCandidate(p, null), false);
});
test('pickLayout: apply beats suggest, then score, then most recently used', () => {
  const p = pkt(undefined, { broker_mc: '445566' });
  const exact = { ...tpl(), id: 'exact', last_used_at: '2026-10-01' };
  const fuzzy = { ...fp([page(tweak(A)), page(tweak(B)), page(tweak(C))]), id: 'fuzzy', status: 'active' };
  const other = { ...fp([page(OTHER)]), id: 'other', status: 'active' };
  assert.equal(pickLayout(p, [other, fuzzy, exact]).layout.id, 'exact');
  assert.equal(pickLayout(p, [other, fuzzy]).layout.id, 'fuzzy');
  assert.equal(pickLayout(p, [other]), null);
  assert.equal(pickLayout(p, []), null);
  const older = { ...tpl(), id: 'older', last_used_at: '2026-09-01T00:00:00Z' }, newer = { ...tpl(), id: 'newer', last_used_at: '2026-10-10T00:00:00Z' };
  assert.equal(pickLayout(p, [older, newer]).layout.id, 'newer');
  assert.equal(pickLayout(p, [{ ...tpl(), id: 'old', status: 'retired' }]), null);
});

// ---------- end to end with real PDFs (pdf-lib → extractPdf → fingerprint) ----------
async function fakeFormPdf({ load = '1001', date = '10/17/2026', mc = '0445566', extraLine = null } = {}) {
  const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]); let y = 740;
  const line = (t) => { p.drawText(t, { x: 50, y, size: 11, font: f }); y -= 22; };
  line('TEST ONLY - Acme Test Logistics Carrier Setup Packet'); line(`Broker MC ${mc}   Load ${load}   Date ${date}`);
  for (const r of ['Carrier legal name', 'MC number', 'DOT number', 'Contact name', 'Phone', 'Email', 'Remit to address', 'Insurance agent']) line(`${r}: ____________________`);
  if (extraLine) line(extraLine);
  for (let i = 0; i < 10; i++) line(WORDS.slice(i * 10, i * 10 + 10).join(' '));
  return doc.save();
}
test('real PDFs: same fake form with new load/date → identical key and broker MC; tweak → fuzzy apply with MC', async () => {
  const ex1 = await extractPdf(await fakeFormPdf());
  const ex2 = await extractPdf(await fakeFormPdf({ load: '88231', date: '11/30/2026' }));
  const ex3 = await extractPdf(await fakeFormPdf({ extraLine: 'New: fuel surcharge policy applies' }));
  const f1 = fingerprintPacket(ex1), f2 = fingerprintPacket(ex2), f3 = fingerprintPacket(ex3);
  assert.equal(f1.layout_key, f2.layout_key);
  assert.deepEqual(f1.fingerprint.pages.map((p) => [p.w, p.h, p.has_text]), [[612, 792, true]]);
  assert.equal(extractBrokerMc(ex1.pages, { ownMc: '111222' }), '445566');
  assert.notEqual(f3.layout_key, f1.layout_key);
  assert.ok(hamming(f1.fingerprint.pages[0].simhash, f3.fingerprint.pages[0].simhash) <= 6);
  const r = scoreLayout({ ...f3, broker_mc: '445566' }, { ...f1, broker_mc: '445566' });
  assert.equal(r.decision, 'apply'); assert.equal(r.reason, 'mc_fuzzy');
  assert.equal(scoreLayout(f2, f1).decision, 'apply');
});
