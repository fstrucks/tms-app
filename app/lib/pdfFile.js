// A PDF picked directly in the scanner (brokers send PDFs): stored as-is, no image processing. Same 10 MB limit as
// scanned PDFs and other PDF uploads (PDF_MAX_BYTES). Pure helpers, used by the browser and the server check.
import { PDF_MAX_BYTES } from './scan.js';

export const PDF_ACCEPT = 'application/pdf,.pdf';
export const looksLikePdfFile = (f) => !!f && (/pdf/i.test(f.type || '') || /\.pdf$/i.test(f.name || ''));
export const hasPdfMagic = (bytes) => !!bytes && bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
export const PDF_PROBLEM = {
  not_pdf: 'That file isn’t a PDF.',
  too_large: 'The PDF is larger than 10 MB.',
  empty: 'That PDF is empty.',
};
// size + first bytes → null (OK) | 'not_pdf' | 'too_large' | 'empty'
export function pdfProblem(size, head) {
  if (!size) return 'empty';
  if (size > PDF_MAX_BYTES) return 'too_large';
  return hasPdfMagic(head) ? null : 'not_pdf';
}
// Browser: File → null | problem code (reads the first bytes).
export async function pdfFileProblem(file) {
  if (!looksLikePdfFile(file)) return 'not_pdf';
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return pdfProblem(file.size, head);
}
// Keep the broker's file name, safe characters only, always ending in .pdf.
export function pdfUploadName(name) {
  const base = String(name || 'document').replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'document';
  return `${base}.pdf`;
}
