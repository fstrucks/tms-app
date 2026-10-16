'use client';
// Manual-mapping screen (presentational). Mobile-first (390px). Pages come from renderPage(pageNo) → { url, w, h } in px@200dpi.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PROFILE_KEYS } from '../lib/packetReader';
import SignaturePad from '../components/PacketSignaturePad';
import { dragBox, isTap, pxPerCss, parseInch } from '../lib/packetDrag';
import { signTarget } from '../lib/packetSignFlow';
import { fillBlockers, isSigField } from '../lib/packetFillReady';
import { saveDraft, loadDraft, clearDraft, applyDraft } from '../lib/packetDraft';
import { formatPacketDate } from '../lib/packetDate';
import { KEY_LABELS, BANK, SENSITIVE, STATE_COLORS, fieldState, summarize, placeBox, nudge, buildPatch, updateField, manualReasonText, unconfirmedBank } from '../lib/packetMapperModel';
import { packetStatusLabel } from '../lib/packetStatus';

const s = {
  main: { padding: '0.75rem', fontFamily: 'system-ui', maxWidth: 560, margin: '0 auto', paddingBottom: 110 },
  muted: { color: '#6b7280', fontSize: 14, margin: '0.25rem 0' },
  banner: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '0.6rem 0.75rem', fontSize: 14, margin: '0.5rem 0' },
  ro: { background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 8, padding: '0.6rem 0.75rem', fontSize: 14, margin: '0.5rem 0' },
  btn: { minHeight: 44, padding: '0 0.9rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, touchAction: 'manipulation' },
  primary: { minHeight: 48, borderRadius: 8, border: 0, background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: 16, width: '100%' },
  input: { width: '100%', minHeight: 44, fontSize: 16, padding: '0 0.6rem', borderRadius: 8, border: '1px solid #d1d5db', boxSizing: 'border-box' }, // 16px: no iOS zoom
  lab: { display: 'block', fontSize: 13, fontWeight: 600, margin: '0.6rem 0 0.25rem' },
  chip: (c) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#fff', background: c }),
};
const DPI_PX = 200; // field boxes are px at 200 dpi
const inches = (px) => Math.round((px / DPI_PX) * 100) / 100;
// Text inside a box. Date fields with no value preview today's date (display only; fills on signing),
// so moving a field never "wipes" it.
export function boxText(f) {
  if (f.kind === 'checkbox') return '';
  if ((f.kind === 'date' || f.profile_key === 'date') && !f.value) return `${formatPacketDate()} (on signing)`;
  if (f.value && !SENSITIVE.has(f.profile_key)) return f.value;
  return KEY_LABELS[f.profile_key] || '';
}
// Inch box: free typing (empty allowed); applies valid numbers as typed, restores the real value on blur.
function InchInput({ label, aria, step, px, onApply }) {
  const real = String(inches(px));
  const [txt, setTxt] = useState(real);
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(real); }, [real, focus]);
  return <label style={{ gridColumn: 'span 2', fontSize: 13 }}>{label}<input type="text" inputMode="decimal" style={s.input} aria-label={aria} data-step={step} value={txt}
    onFocus={() => setFocus(true)}
    onChange={(e) => { const v = e.target.value; setTxt(v); const n = parseInch(v); if (n != null) onApply(n); }}
    onBlur={() => { setFocus(false); const n = parseInch(txt); if (n != null) onApply(n); setTxt(String(inches(px))); }} /></label>;
}
const STATE_TEXT = { sign: 'Needs signature', unmapped: 'Needs a name', confirm: 'Confirm bank #', check: 'Check value', ok: 'OK' };

export default function PacketMapper({ packet, fields: initial, canEdit, pageCount, renderPage, onSave, onSign, onFill, onClearSig, loadSignatures, loginHref = '/login', signerName = '', initialSel = null, initialSigMenu = null }) {
  const [fields, setFields] = useState(initial);
  const [deleted, setDeleted] = useState([]);
  const [page, setPage] = useState(1);
  const [img, setImg] = useState(null);
  const [sel, setSel] = useState(initialSel);
  const [placing, setPlacing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(null); // signature field id being signed
  const [filled, setFilled] = useState(null); // { url, filename }
  const drag = useRef(null);
  const raf = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [sigUrls, setSigUrls] = useState({});
  const [sigMenu, setSigMenu] = useState(initialSigMenu); // signed field id → Re-sign / Clear
  const [signedOut, setSignedOut] = useState(false);
  const store = typeof window !== 'undefined' ? window.sessionStorage : null;
  const wrap = useRef(null);
  const [dispW, setDispW] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => { // track the page's displayed width so boxes scale with it (rotation, resize)
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setDispW(el.clientWidth)); ro.observe(el); setDispW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { // restore unsaved edits kept from before a sign-out / reload
    const r = applyDraft(initial, store && loadDraft(store, packet.id));
    setFields(r.fields); setDeleted(r.deleted);
    if (r.restored) setMsg(`Restored ${r.restored} unsaved change${r.restored === 1 ? '' : 's'}.${r.secretsDropped ? ' Re-type bank/EIN numbers (they are never stored in the browser).' : ''} Tap Save to keep them.`);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (store) saveDraft(store, packet.id, fields, deleted); }, [fields, deleted]); // eslint-disable-line react-hooks/exhaustive-deps
  const signedKey = fields.filter((f) => f.signed).map((f) => `${f.id}:${f.signed_at}`).join(',');
  useEffect(() => {
    if (!signedKey || !loadSignatures) return setSigUrls({});
    let on = true; loadSignatures().then((r) => { if (on && r?.urls) setSigUrls(r.urls); });
    return () => { on = false; };
  }, [signedKey, loadSignatures]);
  const handle = (r) => { if (r?.signedOut) { setSignedOut(true); setMsg(r.error); return true; } return false; };
  useEffect(() => { let on = true; setImg(null); Promise.resolve(renderPage(page)).then((r) => on && setImg(r)); return () => { on = false; }; }, [page, renderPage]);

  const onPage = fields.filter((f) => f.page === page);
  const sum = useMemo(() => summarize(fields), [fields]);
  const dirty = fields.some((f) => f.dirty) || deleted.length > 0;
  const cur = fields.find((f) => f.id === sel) || null;
  const scale = img && dispW ? dispW / img.w : 0;
  const set = (id, patch) => setFields((fs) => fs.map((f) => (f.id === id ? updateField(f, patch) : f)));

  function tapPage(e) {
    if (!placing || !canEdit || !img) return;
    const r = e.currentTarget.getBoundingClientRect(), k = img.w / r.width;
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
    const id = `tmp-${Date.now().toString(36)}`;
    const f = { id, field_key: `u-${id.slice(4)}`, page, kind: 'text', label: '', box: placeBox(x, y, img.w, img.h), profile_key: null, value: '', confirmed: false, page_w: img.w, page_h: img.h, dirty: true, source: 'user' };
    setFields((fs) => [...fs, f]); setSel(id); setPlacing(false);
  }
  // Drag to move / drag the corner handle to resize (mouse + touch via Pointer Events). Editors only.
  function startDrag(e, f, mode) {
    e.stopPropagation();
    if (placing) return;
    if (!canEdit) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: f.id, mode, x: e.clientX, y: e.clientY, box: f.box, moved: false, k: pxPerCss(wrap.current, img) };
    setDragging(true);
  }
  function moveDrag(e) {
    const d = drag.current; if (!d || !img) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && isTap(dx, dy)) return;
    d.moved = true; d.dx = dx; d.dy = dy;
    if (!raf.current) raf.current = requestAnimationFrame(() => { // one state update per frame: smooth on phones
      raf.current = 0; const c = drag.current; if (!c) return;
      set(c.id, { box: dragBox(c.box, c.mode, c.dx * c.k, c.dy * c.k, img.w, img.h) });
    });
  }
  function stopDrag() {
    const d = drag.current; drag.current = null; setDragging(false);
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
    if (d?.moved) set(d.id, { box: dragBox(d.box, d.mode, d.dx * d.k, d.dy * d.k, img.w, img.h) }); // final position
    return d;
  }
  function endDrag(e, f) {
    const d = stopDrag();
    if (d && d.moved) { e.stopPropagation(); return; }
    tapField(f);
  }
  function tapField(f) {
    if (placing) return;
    setSel(f.id);
    if (!canEdit || !onSign) return;
    if (isSigField(f) && f.signed) return setSigMenu(f.id);
    startSign(f);
  }
  function startSign(f) {
    const t = signTarget(fields, f);
    if (!t) return;
    if (t.error) return setMsg(t.error);
    if (fields.some((x) => x.dirty) || deleted.length) return setMsg('Save your changes first, then tap the signature field to sign.');
    setSigning(t.id);
  }
  async function doSign(r) {
    const id = signing; setSigning(null); setSel(null); setBusy(true); setMsg(null); // no edit panel popping up after Done
    const res = await onSign({ fieldId: id, ...r });
    setBusy(false);
    if (handle(res)) return;
    if (res?.error) return setMsg(res.error);
    if (res?.fields) setFields(res.fields);
    setMsg(`Signed by ${r.signerName}. Date filled: ${res.date}.`);
  }
  async function doFill() {
    setBusy(true); setMsg(null); setFilled(null);
    const res = await onFill();
    setBusy(false);
    if (handle(res)) return;
    if (res?.error) { if (res.missing?.[0]) { setPage(res.missing[0].page); setSel(res.missing[0].id); } return setMsg(res.error); }
    setFilled({ url: res.url, filename: res.filename }); setMsg('Filled PDF saved.');
  }
  async function clearSig(id) {
    setSigMenu(null); setBusy(true); setMsg(null);
    const r = await onClearSig(id);
    setBusy(false);
    if (handle(r)) return;
    if (r?.error) return setMsg(r.error);
    if (r?.fields) setFields((fs) => r.fields.map((n) => { const local = fs.find((x) => x.id === n.id && x.dirty); return local ? { ...local, signed: false, signer_name: null, signed_at: null } : n; }));
    setFilled(null); setMsg('Signature cleared.');
  }
  function reSign(id) {
    setSigMenu(null);
    if (fields.some((x) => x.dirty) || deleted.length) return setMsg('Save your changes first, then re-sign.');
    setSigning(id);
  }
  const blockers = unconfirmedBank(fields);
  const fillWhy = fillBlockers(fields, { dirty });
  async function save() {
    if (blockers.length) { // bank numbers must be confirmed before anything is saved
      const b = blockers[0]; setPage(b.page); setSel(b.id);
      return setMsg(`Confirm the ${KEY_LABELS[b.profile_key].toLowerCase()} first: tick “I checked this number” (or clear the number).`);
    }
    const bad = fields.find((f) => f.dirty && BANK.has(f.profile_key) && f.check && !f.check.ok);
    if (bad) { setPage(bad.page); setSel(bad.id); return setMsg(bad.check.message); }
    setBusy(true); setMsg(null);
    const r = await onSave(buildPatch(fields, deleted));
    setBusy(false);
    if (handle(r)) return;
    if (r?.error) return setMsg(r.error);
    if (store) clearDraft(store, packet.id);
    if (r?.errors?.length) setMsg(r.errors.map((x) => x.error).join(' · '));
    else setMsg('Saved.');
    if (r?.fields) { setFields(r.fields); setDeleted([]); setSel(null); }
  }

  return (
    <main style={s.main}>
      <a href="/packets" style={{ fontSize: 14 }}>‹ Packets</a>
      <h1 style={{ fontSize: 20, margin: '0.4rem 0 0', overflowWrap: 'anywhere' }}>{packet.subject || packet.original_filename || 'Carrier packet'}</h1>
      <p style={s.muted}>{packet.source === 'email' ? 'Emailed' : 'Uploaded'} · {packetStatusLabel(packet.status)}{packet.page_count ? ` · ${packet.page_count} pages` : ''}</p>
      {packet.manual_reason && <p role="status" style={s.banner}>{manualReasonText(packet.manual_reason, canEdit)}</p>}
      {packet.status === 'processing' && <p role="status" style={s.banner}>Finding fields… this usually takes a few seconds.</p>}
      {packet.status === 'error' && <p role="alert" style={s.banner}>Field detection failed. {canEdit ? 'You can add fields by hand or try again.' : ''}</p>}
      {!canEdit && <p style={s.ro}>View only. Drivers can view packets; the owner, dispatcher or management fill them out.</p>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0.5rem 0' }} aria-label="Field summary">
        <span style={s.chip('#374151')}>{sum.total} fields</span>
        {sum.sign > 0 && <span style={s.chip(STATE_COLORS.sign)}>{sum.sign} to sign</span>}
        {sum.unmapped > 0 && <span style={s.chip(STATE_COLORS.unmapped)}>{sum.unmapped} need a name</span>}
        {sum.confirm > 0 && <span style={s.chip(STATE_COLORS.confirm)}>{sum.confirm} bank # to confirm</span>}
        {sum.check > 0 && <span style={s.chip(STATE_COLORS.check)}>{sum.check} to check</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0.5rem 0' }}>
        <button style={s.btn} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page">‹</button>
        <span style={{ flex: 1, textAlign: 'center', fontSize: 15 }}>Page {page} of {pageCount || 1}</span>
        <button style={s.btn} onClick={() => setPage((p) => Math.min(pageCount || 1, p + 1))} disabled={page >= (pageCount || 1)} aria-label="Next page">›</button>
        {canEdit && <button style={{ ...s.btn, ...(placing ? { background: '#2563eb', color: '#fff', borderColor: '#2563eb' } : null) }} onClick={() => setPlacing((v) => !v)}>{placing ? 'Tap page…' : '＋ Add field'}</button>}
      </div>
      <div style={{ overflowX: zoom > 1 ? 'auto' : 'hidden', WebkitOverflowScrolling: 'touch', borderRadius: 6 }}>
      <div ref={wrap} onClick={tapPage} data-testid="page" style={{ touchAction: dragging ? 'none' : 'auto', position: 'relative', width: `${zoom * 100}%`, border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden', background: '#fff', cursor: placing ? 'crosshair' : 'default', aspectRatio: img ? `${img.w} / ${img.h}` : '8.5 / 11' }}>
        {img ? <img src={img.url} alt={`Page ${page}`} style={{ width: '100%', display: 'block' }} draggable={false} /> : <p style={{ ...s.muted, padding: '1rem' }}>Loading page…</p>}
        {img && scale > 0 && onPage.map((f) => {
          const st = fieldState(f), [x0, y0, x1, y1] = f.box;
          return <button key={f.id} data-field={f.id} aria-label={`${KEY_LABELS[f.profile_key] || f.label || 'Field'}: ${STATE_TEXT[st]}`}
            onClick={(e) => { e.stopPropagation(); if (!canEdit || e.detail === 0) tapField(f); }}
            onPointerDown={canEdit ? (e) => startDrag(e, f, 'move') : undefined} onPointerMove={canEdit ? moveDrag : undefined}
            onPointerUp={canEdit ? (e) => endDrag(e, f) : undefined} onPointerCancel={() => stopDrag()}
            style={{ zIndex: sel === f.id ? 2 : 1, touchAction: canEdit ? 'none' : 'auto', cursor: canEdit ? 'move' : 'pointer', overflow: 'visible', position: 'absolute', left: x0 * scale, top: y0 * scale, width: Math.max(8, (x1 - x0) * scale), height: Math.max(6, (y1 - y0) * scale), border: `2px solid ${STATE_COLORS[st]}`, background: sel === f.id ? `${STATE_COLORS[st]}33` : `${STATE_COLORS[st]}14`, borderRadius: 3, padding: 0, boxSizing: 'border-box', minHeight: 0, minWidth: 0, lineHeight: 1, display: 'block', fontSize: 9, color: STATE_COLORS[st], textAlign: 'left', whiteSpace: 'nowrap' }}>
            {f.signed && sigUrls[f.id]
              ? <img src={sigUrls[f.id]} alt={`Signature of ${f.signer_name || 'signer'}`} draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
              : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', height: '100%' }}>{boxText(f)}</span>}
            {canEdit && sel === f.id && <span role="presentation" data-resize={f.id} onPointerDown={(e) => startDrag(e, f, 'resize')} onPointerMove={moveDrag}
              onPointerUp={(e) => { e.stopPropagation(); stopDrag(); }} onPointerCancel={(e) => { e.stopPropagation(); stopDrag(); }}
              style={{ position: 'absolute', right: -22, bottom: -22, width: 44, height: 44, zIndex: 3, touchAction: 'none', cursor: 'nwse-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ width: 16, height: 16, background: STATE_COLORS[st], border: '2px solid #fff', borderRadius: 4, boxShadow: '0 0 0 1px rgba(0,0,0,.3)', pointerEvents: 'none' }} />
            </span>}
          </button>;
        })}
      </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button style={{ ...s.btn, minHeight: 36, fontSize: 14 }} onClick={() => setZoom((z) => (z === 1 ? 2.5 : 1))}>{zoom === 1 ? '🔍 Zoom in' : 'Fit to width'}</button>
      </div>

      {signedOut && <p role="alert" style={{ ...s.banner, background: '#fef2f2', borderColor: '#fca5a5' }}>You were signed out. <a href={loginHref}>Sign in again</a>. Your unsaved changes are kept on this device and come back after you sign in.</p>}
      {canEdit && sigMenu && (() => { const f = fields.find((x) => x.id === sigMenu); return f && <section aria-label="Signature options" style={{ border: '2px solid #059669', borderRadius: 12, padding: '0.75rem', margin: '0.75rem 0', background: '#f0fdf4' }}>
        <p style={{ margin: '0 0 0.5rem' }}>Signed by <strong>{f.signer_name || 'signer'}</strong>{f.signed_at ? ` on ${formatPacketDate(f.signed_at)}` : ''}.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...s.btn, flex: 1 }} onClick={() => reSign(f.id)} disabled={busy}>Re-sign</button>
          <button style={{ ...s.btn, flex: 1, color: '#b91c1c', borderColor: '#fca5a5' }} onClick={() => clearSig(f.id)} disabled={busy}>Clear signature</button>
          <button style={s.btn} onClick={() => setSigMenu(null)} aria-label="Close signature options">✕</button>
        </div></section>; })()}
      {signing && <SignaturePad title="Sign the packet" initialName={signerName} onDone={doSign} onCancel={() => { setSigning(null); setSel(null); }} />}
      {cur && !(isSigField(cur) && (sigMenu === cur.id || signing)) && <FieldEditor f={cur} canEdit={canEdit} onChange={(p) => set(cur.id, p)} onClose={() => setSel(null)} img={img}
        onDelete={() => { setDeleted((d) => [...d, cur.id]); setFields((fs) => fs.filter((x) => x.id !== cur.id)); setSel(null); }} />}

      <h2 style={{ fontSize: 16, margin: '1rem 0 0.4rem' }}>Fields on this page</h2>
      {onPage.length === 0 ? <p style={s.muted}>None yet.</p> : onPage.map((f) => {
        const st = fieldState(f);
        return <button key={f.id} onClick={() => setSel(f.id)} style={{ ...s.btn, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, textAlign: 'left' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{KEY_LABELS[f.profile_key] || f.label || 'Unnamed field'}{f.value ? ` · ${f.value}` : ''}</span>
          <span style={s.chip(STATE_COLORS[st])}>{STATE_TEXT[st]}</span></button>;
      })}

      {canEdit && <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(var(--nav-h, 0px) + env(safe-area-inset-bottom))', zIndex: 45, background: '#fff', borderTop: '1px solid #e5e7eb', padding: '0.6rem 0.75rem' }}>
        <div style={{ maxWidth: 536, margin: '0 auto' }}>
          {msg ? <p role="status" style={{ margin: '0 0 0.4rem', fontSize: 14 }}>{msg}</p>
            : blockers.length > 0 && <p role="status" style={{ margin: '0 0 0.4rem', fontSize: 14, color: '#b91c1c' }}>{blockers.length === 1 ? '1 bank number needs' : `${blockers.length} bank numbers need`} your confirmation before saving.</p>}
          {filled?.url && <p style={{ margin: '0 0 0.4rem', fontSize: 15 }}><a href={filled.url} download={filled.filename}>⬇ Download filled PDF</a></p>}
          {dirty || !onFill
            ? <button style={{ ...s.primary, opacity: dirty && !busy && !blockers.length ? 1 : 0.5 }} disabled={!dirty || busy} aria-disabled={blockers.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
            : <>
              {fillWhy.length > 0 && <p role="status" data-testid="fill-why" style={{ margin: '0 0 0.4rem', fontSize: 14, color: '#92400e' }}>To fill: {fillWhy.map((w, i) => <span key={w.code}>{i ? ' · ' : ''}{w.field ? <a href="#" onClick={(e) => { e.preventDefault(); setPage(w.field.page); if (w.code === 'unsigned') { setSel(null); startSign(w.field); } else setSel(w.field.id); }}>{w.text}</a> : w.text}</span>)}</p>}
              <button style={{ ...s.primary, background: '#059669', opacity: busy || fillWhy.length ? 0.5 : 1 }} disabled={busy || fillWhy.length > 0} aria-disabled={fillWhy.length > 0} onClick={doFill}>{busy ? 'Working…' : 'Fill & download PDF'}</button>
            </>}
        </div>
      </div>}
    </main>
  );
}

function FieldEditor({ f, canEdit, onChange, onClose, onDelete, img }) {
  const bank = BANK.has(f.profile_key), sensitive = SENSITIVE.has(f.profile_key);
  const dis = !canEdit;
  const mv = (dx, dy, dw) => img && onChange({ box: nudge(f.box, dx, dy, dw, img.w, img.h) });
  const rs = (dw, dh) => img && onChange({ box: dragBox(f.box, 'resize', dw, dh, img.w, img.h) });
  const setIn = (w, h) => { if (!img) return; const W = w == null ? null : Number(w) * DPI_PX, H = h == null ? null : Number(h) * DPI_PX; if ((W != null && !(W > 0)) || (H != null && !(H > 0))) return; rs(W == null ? 0 : W - (f.box[2] - f.box[0]), H == null ? 0 : H - (f.box[3] - f.box[1])); };
  return (
    <section aria-label="Edit field" style={{ border: '2px solid #2563eb', borderRadius: 12, padding: '0.75rem', margin: '0.75rem 0', background: '#f8fafc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{f.label ? `“${f.label}”` : 'New field'}</strong>
        {(canEdit || !(f.kind === 'signature' || f.profile_key === 'signature')) && <button style={s.btn} onClick={onClose}>Done</button>}
      </div>
      {f.source === 'model' && f.confidence < 0.6 && <p style={{ ...s.muted, color: '#b45309' }}>Low confidence name. Please check it.</p>}
      <label style={s.lab} htmlFor="pf-key">Name</label>
      <select id="pf-key" style={s.input} disabled={dis} value={f.profile_key || ''} onChange={(e) => onChange({ profile_key: e.target.value || null })}>
        <option value="">Choose…</option>
        {PROFILE_KEYS.filter((k) => k !== 'unknown').map((k) => <option key={k} value={k}>{KEY_LABELS[k]}</option>)}
      </select>
      <label style={s.lab} htmlFor="pf-kind">Type</label>
      <select id="pf-kind" style={s.input} disabled={dis} value={f.kind} onChange={(e) => onChange({ kind: e.target.value })}>
        <option value="text">Text</option><option value="date">Date</option><option value="checkbox">Checkbox</option><option value="signature">Signature</option>
      </select>
      <label style={s.lab} htmlFor="pf-label">Label on the form</label>
      <input id="pf-label" style={s.input} disabled={dis} value={f.label || ''} onChange={(e) => onChange({ label: e.target.value })} />
      {f.kind !== 'signature' && f.kind !== 'checkbox' && <>
        <label style={s.lab} htmlFor="pf-val">Value{sensitive ? ' (stored encrypted)' : ''}</label>
        <input id="pf-val" style={s.input} disabled={dis} value={f.value || ''} autoComplete="off" inputMode={bank ? 'numeric' : undefined}
          placeholder={sensitive && f.has_value ? 'Saved. Type to replace' : ''} onFocus={(e) => { if (sensitive && /^•/.test(e.target.value)) onChange({ value: '' }); }}
          onChange={(e) => onChange({ value: e.target.value })} />
        {f.check && !f.check.ok && <p style={{ ...s.muted, color: '#b45309' }}>{f.check.message}</p>}
      </>}
      {f.kind === 'signature' && <p style={s.muted}>Signatures are placed with “Sign all” on the review step.</p>}
      {bank && <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: '0.75rem', padding: '0.6rem', borderRadius: 8, background: f.confirmed ? '#f0fdf4' : '#fef2f2', border: `1px solid ${f.confirmed ? '#86efac' : '#fca5a5'}` }}>
        <input type="checkbox" style={{ width: 24, height: 24, flex: 'none' }} disabled={dis || !(f.value || f.has_value)} checked={!!f.confirmed} onChange={(e) => onChange({ confirmed: e.target.checked })} />
        <span style={{ fontSize: 14 }}>I checked this {f.profile_key === 'bank_routing' ? 'routing' : 'account'} number against my bank records. Required before signing.</span>
      </label>}
      {canEdit && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: '0.75rem' }} aria-label="Move or resize">
          <button style={s.btn} onClick={() => mv(0, -6, 0)} aria-label="Move up">↑</button>
          <button style={s.btn} onClick={() => mv(0, 6, 0)} aria-label="Move down">↓</button>
          <button style={s.btn} onClick={() => mv(-10, 0, 0)} aria-label="Move left">←</button>
          <button style={s.btn} onClick={() => mv(10, 0, 0)} aria-label="Move right">→</button>
          <button style={{ ...s.btn, gridColumn: 'span 2' }} onClick={() => mv(0, 0, -40)}>Narrower</button>
          <button style={{ ...s.btn, gridColumn: 'span 2' }} onClick={() => mv(0, 0, 40)}>Wider</button>
          <button style={{ ...s.btn, gridColumn: 'span 2' }} onClick={() => rs(0, -8)}>Shorter</button>
          <button style={{ ...s.btn, gridColumn: 'span 2' }} onClick={() => rs(0, 8)}>Taller</button>
          <InchInput label="Width (in)" aria="Width in inches" step="0.1" px={f.box[2] - f.box[0]} onApply={(v) => setIn(v, null)} />
          <InchInput label="Height (in)" aria="Height in inches" step="0.05" px={f.box[3] - f.box[1]} onApply={(v) => setIn(null, v)} />
        </div>
        <button style={{ ...s.btn, width: '100%', marginTop: '0.75rem', color: '#b91c1c', borderColor: '#fca5a5' }} onClick={onDelete}>Remove field</button>
      </>}
    </section>
  );
}
