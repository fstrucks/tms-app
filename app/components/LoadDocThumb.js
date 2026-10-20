'use client';
// Small preview for a load document: the photo for images, page 1 for PDFs (rendered in the browser with pdf.js,
// loaded only when a PDF thumbnail is shown), else a "PDF"/"DOC" tile. Tapping opens the document.
import { useEffect, useRef, useState } from 'react';

const W = 48, H = 60;
const box = { flex: 'none', width: W, height: H, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2, var(--divider))', overflow: 'hidden', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' };
const isPdf = (doc) => /\.pdf$/i.test(doc.original_filename || '') || /\.pdf(\?|$)/i.test(doc.url || '');

// First page → small JPEG data URL. Null on any failure (the tile stays).
export async function pdfFirstPageThumb(url, { width = W * 2 } = {}) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'; // same worker as the packet viewer
  const pdf = await lib.getDocument({ url, disableAutoFetch: true, disableStream: true }).promise;
  try {
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / v1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas.toDataURL('image/jpeg', 0.7);
  } finally { pdf.destroy(); }
}

export default function LoadDocThumb({ doc, onOpen }) {
  const [broken, setBroken] = useState(false);
  const [pdfThumb, setPdfThumb] = useState(null);
  const tried = useRef(null);
  useEffect(() => {
    if (doc.isImage || !doc.url || !isPdf(doc) || tried.current === doc.url) return;
    tried.current = doc.url;
    let live = true;
    pdfFirstPageThumb(doc.url).then((t) => { if (live) setPdfThumb(t); }).catch(() => {});
    return () => { live = false; };
  }, [doc.url]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = `Open ${doc.label || 'document'} ${doc.original_filename || ''}`.trim();
  const src = doc.isImage && doc.url && !broken ? doc.url : pdfThumb;
  return (
    <button type="button" data-testid="load-doc-thumb" onClick={onOpen} aria-label={label} style={box}>
      {src
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
        : <span>{isPdf(doc) ? 'PDF' : 'DOC'}</span>}
    </button>
  );
}
