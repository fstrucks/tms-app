// Invoice PDF (one Letter page) with pdf-lib, built on the server from the invoice's saved copy of the details, so the
// same invoice always prints the same. Standard fonts only (WinAnsi), so text is cleaned to plain characters first.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { termsLabel, statusLabel, companyAddress } from './invoice.js';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const plain = (v) => String(v ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/·/g, '-')
  .replace(/[^\x20-\x7E\n]/g, '');
const fmtDate = (d) => { if (!d) return '-'; const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return isNaN(x) ? '-' : x.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }); };

function wrap(text, font, size, width) {
  const out = [];
  for (const para of plain(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  return out;
}

// invoice: invoices row; company: company_profiles row; logo: { bytes, type } | null → Uint8Array
export async function invoicePdf(invoice, company, { logo = null } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.4, 0.4, 0.45), line = rgb(0.8, 0.8, 0.82);
  const M = 48, W = 612 - 2 * M;
  let y = 744;
  const text = (t, x, yy, { f = font, size = 10, color = ink } = {}) => page.drawText(plain(t), { x, y: yy, size, font: f, color });
  const right = (t, xr, yy, o = {}) => { const f = o.f || font, size = o.size || 10; text(t, xr - f.widthOfTextAtSize(plain(t), size), yy, o); };
  const block = (lines, x, yy, width, o = {}) => { let k = yy; for (const l of lines.flatMap((t) => wrap(t, o.f || font, o.size || 10, width))) { text(l, x, k, o); k -= (o.size || 10) + 3; } return k; };

  // Header: logo or name (left), INVOICE + number (right)
  let left = y;
  if (logo?.bytes) {
    try {
      const img = /png/i.test(logo.type || '') ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
      const sc = Math.min(160 / img.width, 48 / img.height, 1);
      page.drawImage(img, { x: M, y: y - img.height * sc + 10, width: img.width * sc, height: img.height * sc });
      left = y - img.height * sc - 6;
    } catch { /* bad image: fall back to the name */ }
  }
  const name = company?.legal_name || company?.dba_name || 'Carrier';
  text(name, M, left, { f: bold, size: 14 });
  const carrier = [company?.dba_name && company?.legal_name ? `DBA ${company.dba_name}` : null, companyAddress(company),
    [company?.phone, company?.email].filter(Boolean).join('  |  '),
    [company?.mc_number ? `MC ${String(company.mc_number).replace(/^MC-?/i, '')}` : null, company?.dot_number ? `USDOT ${company.dot_number}` : null].filter(Boolean).join('  |  ')].filter(Boolean);
  const leftEnd = block(carrier, M, left - 16, W / 2, { color: muted, size: 9 });

  right('INVOICE', M + W, y, { f: bold, size: 20 });
  const meta = [['Invoice #', invoice.invoice_number || 'DRAFT'], ['Invoice date', fmtDate(invoice.invoice_date)], ['Terms', termsLabel(invoice.terms_days)],
    ['Due date', fmtDate(invoice.due_date)], ['Load #', invoice.load_ref?.load_number || '-']];
  let my = y - 22;
  for (const [k, v] of meta) { right(v, M + W, my, { f: bold, size: 10 }); right(k, M + W - 110, my, { color: muted, size: 9 }); my -= 14; }
  if (invoice.status === 'draft' || invoice.status === 'void') right(statusLabel(invoice.status).toUpperCase(), M + W, my - 4, { f: bold, size: 12, color: rgb(0.75, 0.1, 0.1) });
  y = Math.min(leftEnd, my) - 18;

  // Bill to | Remit to
  const bt = invoice.bill_to || {};
  text('BILL TO', M, y, { f: bold, size: 9, color: muted });
  text('REMIT TO', M + W / 2, y, { f: bold, size: 9, color: muted });
  const by = block([bt.name || '-', bt.mc_number ? `MC ${String(bt.mc_number).replace(/^MC-?/i, '')}` : '', bt.address || '', (bt.emails || []).join(', ')].filter(Boolean), M, y - 14, W / 2 - 12);
  const ry = block([invoice.remit_to || name], M + W / 2, y - 14, W / 2);
  y = Math.min(by, ry) - 6;
  if (invoice.factored) { y = block(['Payment for this invoice has been assigned. Pay only to the remit-to above.'], M, y, W, { f: bold, size: 9 }) - 4; }

  // Lane
  const lr = invoice.load_ref || {};
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.5, color: line }); y -= 16;
  text('LOAD DETAILS', M, y, { f: bold, size: 9, color: muted }); y -= 14;
  const refs = [lr.load_number ? `Load # ${lr.load_number}` : null, lr.pickup_numbers?.length ? `Pickup # ${lr.pickup_numbers.join(', ')}` : null,
    lr.commodity ? `Commodity: ${lr.commodity}` : null, lr.weight ? `Weight: ${Number(lr.weight).toLocaleString('en-US')} lb` : null].filter(Boolean).join('   |   ');
  if (refs) y = block([refs], M, y, W, { size: 9 }) - 2;
  for (const s of lr.lane || []) {
    y = block([`${s.type === 'pickup' ? 'Pickup' : s.type === 'delivery' ? 'Delivery' : 'Stop'}: ${[s.name, s.place].filter(Boolean).join(' - ') || '-'}${s.date ? `  (${fmtDate(s.date)})` : ''}`], M, y, W, { size: 9 });
  }
  y -= 10;

  // Charges
  page.drawRectangle({ x: M, y: y - 4, width: W, height: 18, color: rgb(0.95, 0.95, 0.96) });
  text('Description', M + 6, y, { f: bold, size: 9 }); right('Amount', M + W - 6, y, { f: bold, size: 9 }); y -= 20;
  for (const l of invoice.line_items || []) {
    const ly = block([l.note ? `${l.label} - ${l.note}` : l.label], M + 6, y, W - 120);
    right(USD.format(Number(l.amount) || 0), M + W - 6, y);
    page.drawLine({ start: { x: M, y: ly + 8 }, end: { x: M + W, y: ly + 8 }, thickness: 0.3, color: line });
    y = ly - 6;
  }
  y -= 8;
  right(USD.format(Number(invoice.total) || 0), M + W - 6, y, { f: bold, size: 13 });
  right('Total due', M + W - 120, y, { f: bold, size: 11 });
  y -= 26;
  if (invoice.notes) y = block([`Notes: ${invoice.notes}`], M, y, W, { size: 9, color: muted });

  text(`${name}${invoice.invoice_number ? `  -  ${invoice.invoice_number}` : ''}`, M, 32, { size: 8, color: muted });
  doc.setTitle(plain(`Invoice ${invoice.invoice_number || 'draft'}`));
  doc.setProducer('PowerHaul TMS'); doc.setCreator('PowerHaul TMS');
  return doc.save();
}
