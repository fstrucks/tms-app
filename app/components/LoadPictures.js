'use client';

// Load pictures on a load's Documents: pick from the photo library (or camera), thumbnail grid, full-screen view.
import { useEffect, useRef, useState } from 'react';
import ConfirmButton from './ui/ConfirmButton';
import { deleteDocument } from '../lib/documents';
import { runPictureBatch, uploadLoadPicture } from '../lib/loadPictures';

const btn = {
  minHeight: 44, minWidth: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--primary)',
  background: 'var(--surface)', color: 'var(--primary)', fontWeight: 600, fontSize: 16,
};
const tap = { minHeight: 44, minWidth: 44, padding: '0 14px', borderRadius: 8, fontSize: 16, fontWeight: 600 };

export default function LoadPictures({ supabase, userId, loadId, pictures = [], onChange }) {
  const inputRef = useRef(null);
  const closeRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [errors, setErrors] = useState([]);
  const [note, setNote] = useState('');
  const [deleteErr, setDeleteErr] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function onPick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || busy) return;
    setBusy(true);
    setErrors([]);
    setNote('');
    setDeleteErr('');
    try {
      const result = await runPictureBatch(files, {
        onProgress: setProgress,
        upload: (prepared) => uploadLoadPicture(supabase, {
          userId, loadId, file: prepared.file, contentType: prepared.contentType,
        }),
      });
      setErrors(result.errors);
      if (result.saved.length) {
        const n = result.saved.length;
        setNote(n === 1 ? 'Added 1 picture.' : `Added ${n} pictures.`);
        await onChange?.();
      }
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function remove(pic) {
    setDeleteErr('');
    const r = await deleteDocument(supabase, { id: pic.id, file_path: pic.file_path }, 'documents');
    if (!r.ok) { setDeleteErr(r.error); return false; }
    if (open?.id === pic.id) setOpen(null);
    await onChange?.();
    return true;
  }

  async function view(pic) {
    if (pic.url) { setOpen(pic); return; }
    if (!pic.file_path) { setDeleteErr('Couldn\'t open the picture. Please try again.'); return; }
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(pic.file_path, 300);
    if (error || !data?.signedUrl) { setDeleteErr('Couldn\'t open the picture. Please try again.'); return; }
    setOpen({ ...pic, url: data.signedUrl });
  }

  const phase = progress?.phase === 'uploading' ? 'Uploading' : 'Reading';

  return (
    <div data-testid="load-pictures" style={{ marginTop: '0.75rem' }}>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <button type="button" data-testid="add-load-pictures" disabled={busy} onClick={() => inputRef.current?.click()} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          Add pictures
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          data-testid="load-picture-input"
          onChange={onPick}
          tabIndex={-1}
          aria-hidden="true"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
        />
      </div>
      {progress && (
        <p role="status" data-testid="load-picture-progress" style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: '0.5rem 0 0' }}>
          {phase} {progress.index} of {progress.total}…
        </p>
      )}
      {note && <p role="status" style={{ color: 'var(--success)', fontSize: '0.9rem', margin: '0.5rem 0 0' }}>{note}</p>}
      {errors.map((err, i) => (
        <p key={`${err.name}-${i}`} role="alert" data-testid="load-picture-error" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '0.35rem 0 0' }}>
          {err.name}: {err.error}
        </p>
      ))}
      {deleteErr && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '0.35rem 0 0' }}>{deleteErr}</p>}
      {pictures.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', margin: '0.85rem 0 0.4rem' }}>Load pictures</h3>
          <div data-testid="load-picture-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 8 }}>
            {pictures.map((pic) => (
              <div key={pic.id} data-confirm-row data-testid="load-picture-tile" style={{ minWidth: 0 }}>
                <button type="button" onClick={() => view(pic)} aria-label={`View ${pic.original_filename || 'picture'}`}
                  style={{ display: 'block', width: '100%', minHeight: 44, padding: 0, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2, var(--divider))', overflow: 'hidden' }}>
                  {pic.url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={pic.url} alt="" style={{ width: '100%', height: 104, objectFit: 'cover', display: 'block' }} />
                    : <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 104, fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Photo</span>}
                </button>
                {pic.own !== false && (
                  <div style={{ marginTop: 4 }}>
                    <ConfirmButton label="Delete" prompt="Delete this picture? The load is kept." ariaLabel={`Delete this picture? ${pic.original_filename || ''}`.trim()} onConfirm={() => remove(pic)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Picture" data-testid="load-picture-viewer"
          style={{ position: 'fixed', inset: 0, zIndex: 2200, background: 'black', display: 'flex', flexDirection: 'column', padding: 'calc(8px + env(safe-area-inset-top)) 8px calc(8px + env(safe-area-inset-bottom))' }}>
          <button ref={closeRef} type="button" onClick={() => setOpen(null)} style={{ ...tap, alignSelf: 'flex-end', border: 'none', background: 'var(--surface)', color: 'var(--text)' }}>Close</button>
          {open.url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={open.url} alt={open.original_filename || 'Load picture'} style={{ flex: 1, minHeight: 0, width: '100%', objectFit: 'contain' }} />
            : <p style={{ color: 'white', fontSize: 16 }}>Couldn&apos;t open this picture.</p>}
        </div>
      )}
    </div>
  );
}
