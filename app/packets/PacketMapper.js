'use client';
// Manual-mapping screen (presentational). Mobile-first (390px). Pages come from renderPage(pageNo) → { url, w, h } in px@200dpi.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PROFILE_KEYS } from '../lib/packetReader';
import SignaturePad from '../components/PacketSignaturePad';
import { dragBox, isTap } from '../lib/packetDrag';
import { signTarget } from '../lib/packetSignFlow';
import { KEY_LABELS, BANK, SENSITIVE, STATE_COLORS, fieldState, summarize, placeBox, nudge, buildPatch, updateField, MANUAL_REASONS, unconfirmedBank } from '../lib/packetMapperModel';

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
const STATE_TEXT = { unmapped: 'Needs a name', confirm: 'Confirm bank #', check: 'Check value', ok: 'OK' };

export default function PacketMapper({ packet, fields: initial, canEdit, pageCount, renderPage, onSave, onSign, onFill, signerName = '' }) {
  const [fields, setFields] = useState(initial);
  const [deleted, setDeleted] = useState([]);
  const [page, setPage] = useState(1);
  const [img, setImg] = useState(null);
  const [sel, setSel] = useState(null);
  const [placing, setPlacing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(null); // signature field id being signed
  const [filled, setFilled] = useState(null); // { url, filename }
  const drag = useRef(null);
  const wrap = useRef(null);
  const [dispW, setDispW] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => { // track the page's displayed width so boxes scale with it (rotation, resize)
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setDispW(el.clientWidth)); ro.observe(el); setDispW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setFields(initial); setDeleted([]); }, [initial]);
  useEffect(() => { let on = true; setImg(null); Promise.resolve(renderPage(page)).then((r) => on && setImg(r)); return () => { on = false; }; }, [page, renderPage]);

  const onPage = fields.filter((f) => f.page === page);
  const sum = useMemo(() => summarize(fields), [fields]);
  const dirty = fields.some((f) => f.dirty) || deleted.length > 0;
  const cur = fields.find((f) => f.id === sel) || null;
  const scale = img && dispW ? dispW / img.w : 0;
  const set = (id, patch) => setFields((fs) => fs.map((f) => (f.id === id ? updateField(f, patch) : f)));

  function tapPage(e) {
    if (!placing || !canEdit || !img) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale, y = (e.clientY - r.top) / scale;
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
    drag.current = { id: f.id, mode, x: e.clientX, y: e.clientY, box: f.box, moved: false };
  }
  function moveDrag(e) {
    const d = drag.current; if (!d || !img) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && isTap(dx, dy)) return;
    d.moved = true;
    set(d.id, { box: dragBox(d.box, d.mode, dx / scale, dy / scale, img.w, img.h) });
  }
  function endDrag(e, f) {
    const d = drag.current; drag.current = null;
    if (d && d.moved) { e.stopPropagation(); return; }
    tapField(f);
  }
  function tapField(f) {
    if (placing) return;
    setSel(f.id);
    if (!canEdit || !onSign) return;
    const t = signTarget(fields, f);
    if (!t) return;
    if (t.error) return setMsg(t.error);
    if (fields.some((x) => x.dirty) || deleted.length) return setMsg('Save your changes first, then tap the signature field to sign.');
    setSigning(t.id);
  }
  async function doSign(r) {
    const id = signing; setSigning(null); setBusy(true); setMsg(null);
    const res = await onSign({ fieldId: id, ...r });
    setBusy(false);
    if (res?.error) return setMsg(res.error);
    if (res?.fields) setFields(res.fields);
    setMsg(`Signed by ${r.signerName}. Date filled: ${res.date}.`);
  }
  async function doFill() {
    setBusy(true); setMsg(null); setFilled(null);
    const res = await onFill();
    setBusy(false);
    if (res?.error) { if (res.missing?.[0]) { setPage(res.missing[0].page); setSel(res.missing[0].id); } return setMsg(res.error); }
    setFilled({ url: res.url, filename: res.filename }); setMsg('Filled PDF saved.');
  }
  const blockers = unconfirmedBank(fields);
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
    if (r?.error) return setMsg(r.error);
    if (r?.errors?.length) setMsg(r.errors.map((x) => x.error).join(' · '));
    else setMsg('Saved.');
    if (r?.fields) { setFields(r.fields); setDeleted([]); setSel(null); }
  }

  return (
    <main style={s.main}>
      <a href="/packets" style={{ fontSize: 14 }}>‹ Packets</a>
      <h1 style={{ fontSize: 20, margin: '0.4rem 0 0', overflowWrap: 'anywhere' }}>{packet.subject || packet.original_filename || 'Carrier packet'}</h1>
      <p style={s.muted}>{packet.source === 'email' ? 'Emailed' : 'Uploaded'} · {packet.status}{packet.page_count ? ` · ${packet.page_count} pages` : ''}</p>
      {packet.manual_reason && <p role="status" style={s.banner}>{MANUAL_REASONS[packet.manual_reason]}</p>}
      {packet.status === 'processing' && <p role="status" style={s.banner}>Finding fields… this usually takes a few seconds.</p>}
      {packet.status === 'error' && <p role="alert" style={s.banner}>Field detection failed. {canEdit ? 'You can add fields by hand or try again.' : ''}</p>}
      {!canEdit && <p style={s.ro}>View only. Drivers can view packets; the owner, dispatcher or management fill them out.</p>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0.5rem 0' }} aria-label="Field summary">
        <span style={s.chip('#374151')}>{sum.total} fields</span>
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
      <div ref={wrap} onClick={tapPage} data-testid="page" style={{ position: 'relative', width: `${zoom * 100}%`, border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden', background: '#fff', cursor: placing ? 'crosshair' : 'default', aspectRatio: img ? `${img.w} / ${img.h}` : '8.5 / 11' }}>
        {img ? <img src={img.url} alt={`Page ${page}`} style={{ width: '100%', display: 'block' }} draggable={false} /> : <p style={{ ...s.muted, padding: '1rem' }}>Loading page…</p>}
        {img && scale > 0 && onPage.map((f) => {
          const st = fieldState(f), [x0, y0, x1, y1] = f.box;
          return <button key={f.id} data-field={f.id} aria-label={`${KEY_LABELS[f.profile_key] || f.label || 'Field'}: ${STATE_TEXT[st]}`}
            onClick={(e) => { e.stopPropagation(); if (!canEdit || e.detail === 0) tapField(f); }}
            onPointerDown={canEdit ? (e) => startDrag(e, f, 'move') : undefined} onPointerMove={canEdit ? moveDrag : undefined}
            onPointerUp={canEdit ? (e) => endDrag(e, f) : undefined} onPointerCancel={() => { drag.current = null; }}
            style={{ touchAction: canEdit ? 'none' : 'auto', cursor: canEdit ? 'move' : 'pointer', position: 'absolute', left: x0 * scale, top: y0 * scale, width: Math.max(8, (x1 - x0) * scale), height: Math.max(6, (y1 - y0) * scale), border: `2px solid ${STATE_COLORS[st]}`, background: sel === f.id ? `${STATE_COLORS[st]}33` : `${STATE_COLORS[st]}14`, borderRadius: 3, padding: 0, boxSizing: 'border-box', minHeight: 0, minWidth: 0, lineHeight: 1, display: 'block', fontSize: 9, color: STATE_COLORS[st], textAlign: 'left', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {f.kind === 'checkbox' ? '' : f.signed ? `✓ ${f.signer_name || 'Signed'}` : (f.value && !SENSITIVE.has(f.profile_key) ? f.value : KEY_LABELS[f.profile_key] || '')}
            {canEdit && sel === f.id && <span role="presentation" data-resize={f.id} onPointerDown={(e) => startDrag(e, f, 'resize')} onPointerMove={moveDrag}
              onPointerUp={(e) => { e.stopPropagation(); drag.current = null; }}
              style={{ position: 'absolute', right: -2, bottom: -2, width: 18, height: 18, background: STATE_COLORS[st], borderRadius: 3, touchAction: 'none', cursor: 'nwse-resize' }} />}
          </button>;
        })}
      </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button style={{ ...s.btn, minHeight: 36, fontSize: 14 }} onClick={() => setZoom((z) => (z === 1 ? 2.5 : 1))}>{zoom === 1 ? '🔍 Zoom in' : 'Fit to width'}</button>
      </div>

      {signing && <SignaturePad title="Sign the packet" initialName={signerName} onDone={doSign} onCancel={() => setSigning(null)} />}
      {cur && <FieldEditor f={cur} canEdit={canEdit} onChange={(p) => set(cur.id, p)} onClose={() => setSel(null)} img={img}
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
            : <button style={{ ...s.primary, background: '#059669', opacity: busy || blockers.length ? 0.5 : 1 }} disabled={busy || blockers.length > 0} onClick={doFill}>{busy ? 'Working…' : 'Fill & download PDF'}</button>}
        </div>
      </div>}
    </main>
  );
}

function FieldEditor({ f, canEdit, onChange, onClose, onDelete, img }) {
  const bank = BANK.has(f.profile_key), sensitive = SENSITIVE.has(f.profile_key);
  const dis = !canEdit;
  const mv = (dx, dy, dw) => img && onChange({ box: nudge(f.box, dx, dy, dw, img.w, img.h) });
  return (
    <section aria-label="Edit field" style={{ border: '2px solid #2563eb', borderRadius: 12, padding: '0.75rem', margin: '0.75rem 0', background: '#f8fafc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{f.label ? `“${f.label}”` : 'New field'}</strong>
        <button style={s.btn} onClick={onClose}>Done</button>
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
        </div>
        <button style={{ ...s.btn, width: '100%', marginTop: '0.75rem', color: '#b91c1c', borderColor: '#fca5a5' }} onClick={onDelete}>Remove field</button>
      </>}
    </section>
  );
}
