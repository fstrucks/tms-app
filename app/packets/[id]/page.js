'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import PacketMapper from '../PacketMapper';
import { loadPacketPdf } from '../../lib/packetPdfLoad';

const DPI = 200;
async function token() { const { data } = await getSupabase().auth.getSession(); return data?.session?.access_token || null; }
async function api(path, opts = {}) {
  const t = await token(); if (!t) return { error: 'Sign in again.', status: 401 };
  const r = await fetch(path, { cache: 'no-store', ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  const j = await r.json().catch(() => ({})); return r.ok ? j : { ...j, error: j.error || 'Something went wrong.', status: r.status };
}

export default function PacketPage({ params }) {
  const id = params.id;
  const [st, setSt] = useState({ loading: true });
  const pdf = useRef(null);
  const cache = useRef(new Map());

  const load = useCallback(async () => {
    if (supabaseConfigError) return setSt({ error: supabaseConfigError });
    let d = await api(`/api/packets/${id}/fields`);
    if (d.setupNeeded) return setSt({ error: d.error, setup: true });
    if (d.error) return setSt({ error: d.error, signedOut: d.status === 401 });
    if (d.packet.status === 'received' || (d.packet.status === 'processing')) { // kick (idempotent) and refresh
      setSt({ ...d, loading: false });
      await api(`/api/packets/${id}/process`, { method: 'POST' });
      d = await api(`/api/packets/${id}/fields`);
      if (d.error) return setSt({ error: d.error });
    }
    if (!pdf.current) {
      const bytes = await loadPacketPdf(id, { call: api, getToken: token });
      if (bytes.error) return setSt({ error: bytes.error });
      try {
        const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'; // copied from pdfjs-dist 4.10.38 (keep versions in sync)
        pdf.current = await lib.getDocument({ data: bytes.data, isEvalSupported: false }).promise;
      } catch (e) { console.error('[packet] pdf', e); return setSt({ error: 'Could not open the packet PDF. Reload to try again.' }); }
    }
    setSt({ ...d, pageCount: pdf.current.numPages, loading: false });
  }, [id]);
  useEffect(() => { load().catch((e) => { console.error('[packet] load', e); setSt({ error: 'Could not load the packet. Reload to try again.' }); }); }, [load]);

  // Render at 200 dpi-equivalent px so boxes line up with server coordinates; displayed scaled to width.
  const renderPage = useCallback(async (n) => {
    if (cache.current.has(n)) return cache.current.get(n);
    const page = await pdf.current.getPage(n);
    const vp = page.getViewport({ scale: Math.min(DPI / 72, 2.2) });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const full = page.getViewport({ scale: DPI / 72 });
    const out = { url: c.toDataURL('image/jpeg', 0.85), w: full.width, h: full.height };
    cache.current.set(n, out); return out;
  }, []);
  const onSave = useCallback((body) => api(`/api/packets/${id}/fields`, { method: 'PATCH', body: JSON.stringify(body) }), [id]);

  if (st.loading) return <main style={{ padding: '1rem', fontFamily: 'system-ui' }}><p>Loading packet…</p></main>;
  if (st.error) return <main style={{ padding: '1rem', fontFamily: 'system-ui' }}><h1>Carrier packet</h1><p role="alert" style={{ color: '#b91c1c' }}>{st.error}</p>{st.signedOut && <a href={`/login?next=/packets/${id}`}>Sign in</a>}</main>;
  return <PacketMapper packet={st.packet} fields={st.fields} canEdit={st.canEdit} pageCount={st.pageCount} renderPage={renderPage} onSave={onSave} />;
}
