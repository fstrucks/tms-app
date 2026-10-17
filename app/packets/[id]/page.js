'use client';
import { sendWrapPadding } from '../../lib/packetLayout';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import PacketMapper from '../PacketMapper';
import PacketSendBroker from '../PacketSendBroker';
import PacketCoiRequest, { COI_FLAG } from '../PacketCoiRequest';
import { loadPacketPdf } from '../../lib/packetPdfLoad';
import { makeApi } from '../../lib/packetApi';

const DPI = 200;
const packetApi = makeApi(() => getSupabase()?.auth);
const api = packetApi.call;
const token = packetApi.token;

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
  const onSign = useCallback((body) => api(`/api/packets/${id}/sign`, { method: 'POST', body: JSON.stringify(body) }), [id]);
  const onFill = useCallback(() => api(`/api/packets/${id}/fill`, { method: 'POST' }), [id]);
  const onClearSig = useCallback((fieldId) => api(`/api/packets/${id}/sign`, { method: 'DELETE', body: JSON.stringify(fieldId ? { fieldId } : {}) }), [id]);
  const [filledAt, setFilledAt] = useState(null);
  const onFillTracked = useCallback(async () => { const r = await onFill(); if (r?.ok) setFilledAt(new Date().toISOString()); return r; }, [onFill]);
  const loadSend = useCallback(() => api(`/api/packets/${id}/send`), [id]);
  const onSend = useCallback((body) => api(`/api/packets/${id}/send`, { method: 'POST', body: JSON.stringify(body) }), [id]);
  const [sendStep, setSendStep] = useState('closed');
  const [coiStep, setCoiStep] = useState('closed');
  const loadCoi = useCallback(() => api(`/api/packets/${id}/coi-request`), [id]);
  const onCoi = useCallback((body) => api(`/api/packets/${id}/coi-request`, { method: 'POST', body: JSON.stringify(body) }), [id]);
  const [barShown, setBarShown] = useState(true);
  const loadSignatures = useCallback(() => api(`/api/packets/${id}/signatures`), [id]);

  if (st.loading) return <main style={{ padding: '1rem', fontFamily: 'system-ui' }}><p>Loading packet…</p></main>;
  if (st.error) return <main style={{ padding: '1rem', fontFamily: 'system-ui' }}><h1>Carrier packet</h1><p role="alert" style={{ color: '#b91c1c' }}>{st.error}</p>{st.signedOut && <a href={`/login?next=/packets/${id}`}>Sign in</a>}</main>;
  return <><PacketMapper packet={st.packet} fields={st.fields} canEdit={st.canEdit} pageCount={st.pageCount} renderPage={renderPage} onSave={onSave} onSign={onSign} onFill={onFillTracked} onClearSig={onClearSig} loadSignatures={loadSignatures} hideActionBar={sendStep === 'write' || sendStep === 'review' || coiStep === 'write' || coiStep === 'review'} onBarShownChange={setBarShown} loginHref={`/login?next=${encodeURIComponent(`/packets/${id}`)}`} />
    <div data-testid="send-wrap" style={{ padding: '0 0.75rem', paddingBottom: sendWrapPadding(barShown) }}><PacketSendBroker load={loadSend} send={onSend} filledAt={filledAt || st.packet.filled_at} onStepChange={setSendStep} />{COI_FLAG && <PacketCoiRequest load={loadCoi} send={onCoi} onStepChange={setCoiStep} />}</div></>;
}
