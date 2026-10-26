// Bundle PDFs with pdf-lib: copies PDF pages and puts each JPG/PNG photo on its own Letter page (fit, centered).
import { PDFDocument } from 'pdf-lib';
import { isImage, isPdf } from './invoiceBundle.js';

async function addDoc(out, doc, bytes) {
  if (isPdf(doc.file_path)) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    return;
  }
  const img = /\.png$/i.test(doc.file_path) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const page = out.addPage([612, 792]);
  const sc = Math.min(572 / img.width, 752 / img.height, 1.5);
  page.drawImage(img, { x: (612 - img.width * sc) / 2, y: (792 - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
}

// One document as its own PDF. download(path) → Uint8Array | null
export async function docToPdf(doc, download) {
  if (!doc || !(isPdf(doc.file_path) || isImage(doc.file_path))) return null;
  const bytes = await download(doc.file_path); if (!bytes) return null;
  if (isPdf(doc.file_path)) return bytes;
  const out = await PDFDocument.create();
  try { await addDoc(out, doc, bytes); } catch { return null; }
  return out.save();
}

// invoiceBytes first (null = no invoice page, the load export "without invoice"), then each file in order.
// Unreadable files are skipped and listed.
export async function buildBundlePdf(invoiceBytes, files, download, { title = 'Invoice packet' } = {}) {
  const out = await PDFDocument.create();
  if (invoiceBytes) for (const p of await out.copyPages(await PDFDocument.load(invoiceBytes), [0])) out.addPage(p);
  const skipped = [];
  for (const f of files) {
    if (f.pdfBytes) { // a sheet built on the fly (Stop times)
      try { const src = await PDFDocument.load(f.pdfBytes); for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p); } catch { skipped.push(f.name); }
      continue;
    }
    if (!f.doc || !f.supported) { skipped.push(f.name); continue; }
    try { const b = await download(f.doc.file_path); if (!b) throw new Error('missing'); await addDoc(out, f.doc, b); } catch { skipped.push(f.name); }
  }
  out.setTitle(title); out.setProducer('PowerHaul TMS'); out.setCreator('PowerHaul TMS');
  return { bytes: await out.save(), skipped };
}
