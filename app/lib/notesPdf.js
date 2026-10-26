// A plain Notes page for the load packet: the note typed at export time, then (if chosen) the load's saved notes.
import { PDFDocument, StandardFonts } from 'pdf-lib';

const clean = (t) => String(t || '').replace(/[^\x20-\x7E\n]/g, (c) => ({ '\u2019': "'", '\u2018': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-' }[c] ?? '?')).replace(/\r/g, '');
function wrap(text, font, size, width) {
  const out = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}

export async function notesPdf({ loadNumber = '', note = '', loadNotes = '' }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]), y = 740;
  const line = (t, f = font, size = 11) => { if (y < 60) { page = doc.addPage([612, 792]); y = 740; } page.drawText(t, { x: 54, y, size, font: f }); y -= size + 5; };
  line(`Notes${loadNumber ? ` - Load ${clean(loadNumber)}` : ''}`, bold, 16); y -= 6;
  const block = (title, text) => { if (!String(text || '').trim()) return; line(title, bold, 12); for (const l of wrap(text, font, 11, 504)) line(l); y -= 10; };
  block('Note', note);
  block('Load notes', loadNotes);
  return doc.save();
}
