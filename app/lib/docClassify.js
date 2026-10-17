// Document-kind classifier for uploads (pure, testable). Used by /api/extract before/after the AI call so a
// certificate of insurance (ACORD 25) uploaded through the rate-con path is saved as 'coi', not 'rate_confirmation'.
const COI_CUES = [
  [/certificate of (liability )?insurance/, 3], [/\bacord\s*25\b/, 3], [/\bacord\b/, 2], [/certificate holder/, 2],
  [/\binsurer [a-f]\b/, 2], [/this certificate is issued as a matter of information/, 3], [/\bproducer\b/, 1],
  [/\binsured\b/, 1], [/insurers? affording coverage/, 2], [/automobile liability/, 1], [/motor truck cargo/, 1],
  [/combined single limit/, 1], [/policy (eff|exp)/, 1], [/additional insured/, 1], [/each occurrence/, 1],
];
const RATECON_CUES = [
  [/rate (confirmation|con\b|agreement)/, 3], [/load (confirmation|tender)/, 2], [/carrier (pay|rate)/, 2], [/line ?haul/, 2],
  [/\bshipper\b/, 1], [/\bconsignee\b/, 1], [/\bpick ?up\b/, 1], [/\bdelivery\b/, 1], [/\bload (#|no\.?|number)/, 1],
  [/total (rate|pay|amount)/, 1], [/\bequipment\b/, 1], [/\bbroker\b/, 1], [/\bmc ?#?\s*\d/, 1], [/detention|lumper/, 1],
];
const score = (t, cues) => cues.reduce((n, [re, w]) => n + (re.test(t) ? w : 0), 0);

export function docKindScores(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  return { coi: score(t, COI_CUES), rate_confirmation: score(t, RATECON_CUES) };
}

// → 'coi' | 'rate_confirmation' | null (not sure)
export function classifyDocText(text) {
  const s = docKindScores(text);
  if (s.coi >= 4 && s.coi > s.rate_confirmation) return 'coi';
  if (s.rate_confirmation >= 3 && s.rate_confirmation >= s.coi) return 'rate_confirmation';
  return null;
}

// Combine the PDF text layer (if any), the AI's own kind, and the heading/labels the AI saw.
// Text evidence wins when it is decisive; otherwise trust the AI's kind.
export function decideDocKind({ pdfText = '', aiKind = null, aiText = '' } = {}) {
  const fromPdf = classifyDocText(pdfText);
  if (fromPdf) return fromPdf;
  const fromAi = classifyDocText(aiText);
  if (fromAi === 'coi' || aiKind === 'coi') return fromAi === 'rate_confirmation' ? 'rate_confirmation' : 'coi';
  return 'rate_confirmation';
}
