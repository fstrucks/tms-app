// One PDF for a driver's qualification file. Drug and alcohol records are never included.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DRIVER_FILE_DOC_TYPES } from './setupCatalog.js';

const ALLOWED = new Set(DRIVER_FILE_DOC_TYPES);

function wrap(text, size) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  const max = Math.floor(500 / (size * 0.5));
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > max) { if (line) lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function driverFileAttachments(docs, driverId) {
  return (docs || []).filter((d) => ALLOWED.has(d.doc_type) && (d.scope_id === driverId || String(d.file_path || '').includes(`/${driverId}/`)));
}

export async function buildDriverFilePdf({ companyName, usdot, driverName, rows, files, date }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const skipped = [];
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const draw = (text, { size = 11, font: f = font, color = rgb(0.1, 0.12, 0.16) } = {}) => {
    for (const line of wrap(text, size)) {
      if (y < 64) { page = pdf.addPage([612, 792]); y = 740; }
      page.drawText(line, { x: 48, y, size, font: f, color });
      y -= size + 6;
    }
  };
  draw(companyName || 'Company', { size: 18, font: bold });
  draw(`Driver file — ${driverName || 'Driver'}`, { size: 14, font: bold });
  draw(`USDOT ${usdot || '—'}`);
  draw(date || '');
  y -= 6;
  draw('Drug and alcohol records are not included in this file.');
  y -= 8;
  draw('Items', { size: 13, font: bold });
  for (const row of rows || []) {
    if (row.category && row.category !== 'driver_files') continue;
    const state = row.done ? 'Done' : row.bucket === 'expired' ? 'Expired' : row.bucket === 'expiring' ? 'Expiring' : 'Missing';
    draw(`${state} — ${row.title}${row.expiryOn ? ` (${row.expiryOn})` : ''}`);
  }
  y -= 8;
  for (const file of files || []) {
    if (!ALLOWED.has(file.docType)) { skipped.push(file.name || 'File'); continue; }
    const bytes = file.bytes;
    if (!bytes?.length) { skipped.push(file.name || 'File'); continue; }
    try {
      const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
      if (isPdf || file.contentType === 'application/pdf') {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const copied = await pdf.copyPages(src, src.getPageIndices());
        copied.forEach((p) => pdf.addPage(p));
        page = pdf.getPages().at(-1);
        y = 64;
      } else if (file.contentType === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50)) {
        const img = await pdf.embedPng(bytes);
        const p = pdf.addPage([612, 792]);
        const scale = Math.min(516 / img.width, 700 / img.height, 1);
        p.drawImage(img, { x: 48, y: 740 - img.height * scale, width: img.width * scale, height: img.height * scale });
      } else if (file.contentType === 'image/jpeg' || bytes[0] === 0xff) {
        const img = await pdf.embedJpg(bytes);
        const p = pdf.addPage([612, 792]);
        const scale = Math.min(516 / img.width, 700 / img.height, 1);
        p.drawImage(img, { x: 48, y: 740 - img.height * scale, width: img.width * scale, height: img.height * scale });
      } else skipped.push(file.name || 'File');
    } catch { skipped.push(file.name || 'File'); }
  }
  if (skipped.length) {
    page = pdf.addPage([612, 792]);
    y = 740;
    draw('These files could not be added to the PDF:', { font: bold });
    skipped.forEach((name) => draw(name));
  }
  return pdf.save();
}
