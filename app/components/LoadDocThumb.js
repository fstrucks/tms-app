'use client';
// Small preview for a load document: the photo itself for images, a "PDF" tile otherwise. Tapping opens it.
import { useState } from 'react';

const box = { flex: 'none', width: 48, height: 60, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2, var(--divider))', overflow: 'hidden', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' };

export default function LoadDocThumb({ doc, onOpen }) {
  const [broken, setBroken] = useState(false);
  const label = `Open ${doc.label || 'document'} ${doc.original_filename || ''}`.trim();
  return (
    <button type="button" data-testid="load-doc-thumb" onClick={onOpen} aria-label={label} style={box}>
      {doc.isImage && doc.url && !broken
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={doc.url} alt="" loading="lazy" onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span>{/\.pdf$/i.test(doc.original_filename || '') ? 'PDF' : 'DOC'}</span>}
    </button>
  );
}
