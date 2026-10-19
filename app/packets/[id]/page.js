'use client';
import { sendWrapPadding } from '../../lib/packetLayout';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import PacketMapper from '../PacketMapper';
import PacketSendBroker from '../PacketSendBroker';
import PacketCoiRequest, { COI_FLAG } from '../PacketCoiRequest';
import { loadPacketPdf } from '../../lib/packetPdfLoad';
import { makeApi } from '../../lib/packetApi';
import { fillWithRetry } from '../../lib/packetFillRetry';

const DPI = 200;
// A failed GET /fields is a "couldn't load" problem unless the session is really gone (401 after the refresh retry).
// 404 keeps its own message ("Packet not found."). Everything else gets a plain retry message, never a sign-in one.
const FIELDS_LOAD_ERROR = 'Couldn’t load this packet’s fields. Try again.';
function fieldsError(d) {
  if (d.signedOut || d.status === 401) return { error: d.error || 'Sign in again.', signedOut: true };
  if (d.status === 404) return { error: d.error || 'Packet not found.' };
  return { error: FIELDS_LOAD_ERROR, retry: true };
}
const PROCESS_POLL_MS = [1500, 2000, 3000, 3000, 5000, 5000, 8000, 8000, 10000, 10000, 10000, 10000, 15000, 15000]; // ~2 min
const isProcessing = (status) => status === 'received' || status === 'processing';
const packetApi = makeApi(() => getSupabase()?.auth);
const api = packetApi.call;
const token = packetApi.token;

export default function PacketPage({ params }) {
  const id = params.id;
  const [st, setSt] = useState({ loading: true });
  const pdf = useRef(null);
  const cache = useRef(new Map());
  // Bumped when the PDF opens so renderPage gets a new identity and the mapper renders the page then (r5).
  const [pdfReady, setPdfReady] = useState(0);
  const openPdf = useCallback(async () => {
    if (pdf.current) return { ok: true };
    const bytes = await loadPacketPdf(id, { call: api, getToken: token });
    if (bytes.error) return { error: bytes.error };
    try {
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'; // copied from pdfjs-dist 4.10.38 (keep versions in sync)
      pdf.current = await lib.getDocument({ data: bytes.data, isEvalSupported: false }).promise;
    } catch (e) { console.error('[packet] pdf', e); return { error: 'Could not open the packet PDF. Reload to try again.' }; }
    cache.current.clear(); setPdfReady((n) => n + 1);
    return { ok: true };
  }, [id]);

  const load = useCallback(async () => {
    if (supabaseConfigError) return setSt({ error: supabaseConfigError });
    let d = await api(`/api/packets/${id}/fields`);
    if (d.setupNeeded) return setSt({ error: d.error, setup: true });
    if (d.error) return setSt(fieldsError(d));
    if (isProcessing(d.packet.status)) { // kick (idempotent) and refresh
      // The PDF is stored at upload, so open it now: the page preview shows while fields are still being found.
      const opened = openPdf();
      setSt({ ...d, loading: false });
      opened.then((o) => { if (o.ok) setSt((cur) => (cur.packet ? { ...cur, pageCount: pdf.current.numPages } : cur)); });
      await api(`/api/packets/${id}/process`, { method: 'POST' });
      d = await api(`/api/packets/${id}/fields`);
      if (d.error) return setSt(fieldsError(d));
      // Already being processed elsewhere (started right after upload): poll until it's done, so the fields and
      // the remembered-layout banner show up without a reload.
      for (let i = 0; isProcessing(d.packet?.status) && i < PROCESS_POLL_MS.length; i++) {
        await new Promise((r) => setTimeout(r, PROCESS_POLL_MS[i]));
        const n = await api(`/api/packets/${id}/fields`);
        if (n.error) break;
        d = n;
      }
    }
    const o = await openPdf();
    if (o.error) return setSt({ error: o.error });
    setSt({ ...d, pageCount: pdf.current.numPages, loading: false });
  }, [id, openPdf]);
  useEffect(() => { load().catch((e) => { console.error('[packet] load', e); setSt({ error: 'Could not load the packet. Reload to try again.' }); }); }, [load]);

  // Render at 200 dpi-equivalent px so boxes line up with server coordinates; displayed scaled to width.
  const renderPage = useCallback(async (n) => {
    if (!pdf.current) return null; // not open yet; called again when pdfReady changes
    if (cache.current.has(n)) return cache.current.get(n);
    const page = await pdf.current.getPage(n);
    const vp = page.getViewport({ scale: Math.min(DPI / 72, 2.2) });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const full = page.getViewport({ scale: DPI / 72 });
    const out = { url: c.toDataURL('image/jpeg', 0.85), w: full.width, h: full.height };
    cache.current.set(n, out); return out;
  }, [pdfReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSave = useCallback((body) => api(`/api/packets/${id}/fields`, { method: 'PATCH', body: JSON.stringify(body) }), [id]);
  const onReload = useCallback(() => api(`/api/packets/${id}/fields`), [id]);
  const onSign = useCallback((body) => api(`/api/packets/${id}/sign`, { method: 'POST', body: JSON.stringify(body) }), [id]);
  // One automatic retry if the connection drops (cold start / slow fill); the server reuses a fill that already
  // finished, so a retry never fills twice.
  const onFill = useCallback(() => fillWithRetry((retry) => api(`/api/packets/${id}/fill${retry ? '?retry=1' : ''}`, { method: 'POST' })), [id]);
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
  if (st.error) return <main style={{ padding: '1rem', fontFamily: 'system-ui' }}><h1>Carrier packet</h1><p role="alert" style={{ color: 'var(--danger)' }}>{st.error}</p>{st.signedOut && <a href={`/login?next=/packets/${id}`}>Sign in</a>}{st.retry && <button type="button" data-testid="fields-retry" style={{ minHeight: 44, padding: '0 1rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 15 }} onClick={() => { setSt({ loading: true }); load().catch(() => setSt({ error: FIELDS_LOAD_ERROR, retry: true })); }}>Try again</button>}</main>;
  return <><PacketMapper packet={st.packet} fields={st.fields} canEdit={st.canEdit} pageCount={st.pageCount} renderPage={renderPage} onSave={onSave} onReload={onReload} onSign={onSign} onFill={onFillTracked} onClearSig={onClearSig} loadSignatures={loadSignatures} hideActionBar={sendStep === 'write' || sendStep === 'review' || coiStep === 'write' || coiStep === 'review'} onBarShownChange={setBarShown} loginHref={`/login?next=${encodeURIComponent(`/packets/${id}`)}`} />
    <div data-testid="send-wrap" style={{ padding: '0 0.75rem', paddingBottom: sendWrapPadding(barShown) }}><PacketSendBroker load={loadSend} send={onSend} filledAt={filledAt || st.packet.filled_at} onStepChange={setSendStep} />{COI_FLAG && <PacketCoiRequest load={loadCoi} send={onCoi} onStepChange={setCoiStep} />}</div></>;
}
