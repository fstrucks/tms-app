'use client';
// Manual-mapping screen (presentational). Mobile-first (390px). Pages come from renderPage(pageNo) → { url, w, h } in px@200dpi.
import { actionBarShown, bottomReservePx, bottomPadding, COLLAPSED_RESERVE } from '../lib/packetLayout';
import { useEffect, useMemo, useRef, useState } from 'react';
import { nameSelectRows, nameGroup, selectValue, keyFromSelect, isCustomKey, customName, customKey, CUSTOM_LABEL, SKIP_KEY } from '../lib/packetFieldNames';
import SignaturePad from '../components/PacketSignaturePad';
import { dragBox, pxPerCss, parseInch, dragDelta } from '../lib/packetDrag';
import { signTarget } from '../lib/packetSignFlow';
import { fillBlockers, isSigField } from '../lib/packetFillReady';
import { saveDraft, loadDraft, clearDraft, applyDraft } from '../lib/packetDraft';
import { formatPacketDate } from '../lib/packetDate';
import { KEY_LABELS, fieldName, rowName, BANK, SENSITIVE, STATE_COLORS, fieldState, summarize, placeBox, nudge, buildPatch, updateField, manualReasonText, unconfirmedBank } from '../lib/packetMapperModel';
import { packetDisplayStatus, fieldSummary, ADD_FIELD_HINT, statusChipStyle } from '../lib/packetStatus';
import { formatListTime } from '../lib/packetDate';
import { layoutBanner, placedCount } from '../lib/packetLayoutBanner';
import { makeApi } from '../lib/packetApi';
import { getSupabase } from '../lib/supabase';

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
let defaultLayoutApi = null; // lazy: GET/POST /api/packets/[id]/layout with the signed-in session
const layoutCall = (...a) => (defaultLayoutApi || (defaultLayoutApi = makeApi(() => getSupabase()?.auth))).call(...a);
const DPI_PX = 200; // field boxes are px at 200 dpi
const inches = (px) => Math.round((px / DPI_PX) * 100) / 100;
// Text inside a box. Date fields with no value preview today's date (display only; fills on signing),
// so moving a field never "wipes" it.
export function boxText(f) {
  if (f.kind === 'checkbox') return '';
  if ((f.kind === 'date' || f.profile_key === 'date') && !f.value) return `${formatPacketDate()} (on signing)`;
  if (f.value && !SENSITIVE.has(f.profile_key)) return f.value;
  if (f.profile_key === SKIP_KEY) return '';
  return fieldName(f.profile_key);
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
// Broker field (QA B): pre-filled from the PDF text when found; editors can correct it. Saves on blur / Enter.
export function BrokerField({ packetId, value, canEdit, api, onSaved }) {
  const [txt, setTxt] = useState(value || '');
  const [state, setState] = useState(null); // null | 'saving' | 'saved' | error text
  const last = useRef(value || '');
  useEffect(() => { setTxt(value || ''); last.current = value || ''; }, [value]);
  if (!canEdit) return value ? <p data-testid="broker-name" style={{ ...s.muted, margin: '0.35rem 0 0' }}>Broker: {value}</p> : null;
  async function save() {
    const v = txt.replace(/\s+/g, ' ').trim();
    if (v === last.current || !api) return;
    setState('saving');
    const r = await api(`/api/packets/${packetId}`, { method: 'PATCH', body: JSON.stringify({ broker_name: v }) });
    if (!r || r.error) return setState(r?.error || 'Could not save the broker.');
    last.current = r.broker_name || ''; setTxt(r.broker_name || ''); setState('saved');
    onSaved && onSaved(r);
  }
  return <div style={{ marginTop: '0.5rem' }}>
    <label htmlFor="packet-broker" style={{ ...s.lab, margin: '0 0 0.25rem' }}>Broker</label>
    <input id="packet-broker" data-testid="broker-input" type="text" autoComplete="organization" maxLength={120} placeholder="Broker company name" style={s.input}
      value={txt} onChange={(e) => { setTxt(e.target.value); setState(null); }} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
    {state && <p role="status" style={{ ...s.muted, fontSize: 13, color: state === 'saving' || state === 'saved' ? '#6b7280' : '#b91c1c' }}>{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Broker saved.' : state}</p>}
  </div>;
}
const STATE_TEXT = { sign: 'Needs signature', unmapped: 'Needs a name', confirm: 'Confirm bank #', check: 'Check value', ok: 'OK', skip: 'Left blank' };

export default function PacketMapper({ packet, fields: initial, canEdit, pageCount, renderPage, onSave, onSign, onFill, onClearSig, loadSignatures, hideActionBar = false, onBarShownChange, loginHref = '/login', signerName = '', initialSel = null, initialSigMenu = null, layoutApi = layoutCall }) {
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
  const base = useRef(initial); // last server copy of the fields (for Discard)
  const raf = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [sigUrls, setSigUrls] = useState({});
  const [sigMenu, setSigMenu] = useState(initialSigMenu); // signed field id → Re-sign / Clear
  const [signedOut, setSignedOut] = useState(false);
  const store = typeof window !== 'undefined' ? window.sessionStorage : null;
  const wrap = useRef(null);
  const bar = useRef(null);
  const [barH, setBarH] = useState(0); // live height of the sticky Discard/Save bar, so content never ends up under it
  useEffect(() => {
    const el = bar.current; if (!el) { setBarH(0); return; } // bar hidden (send step): drop its padding
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBarH(el.offsetHeight)); ro.observe(el); setBarH(el.offsetHeight);
    return () => ro.disconnect();
  });
  const [dispW, setDispW] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => { // track the page's displayed width so boxes scale with it (rotation, resize)
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setDispW(el.clientWidth)); ro.observe(el); setDispW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { // restore unsaved edits kept from before a sign-out / reload
    base.current = initial;
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
  // Remembered broker layout (carrier packet G): banner + "Don't use this layout" / "Use layout".
  const [layoutInfo, setLayoutInfo] = useState(null);
  const [brokerName, setBrokerName] = useState(packet?.broker_name || null);
  useEffect(() => { setBrokerName(packet?.broker_name || null); }, [packet?.broker_name]);
  const [layoutTick, setLayoutTick] = useState(0);
  // Re-read the banner whenever processing finishes or the packet changes (first open: the packet is still being
  // processed when the mapper mounts, so the first read has nothing to show — QA D).
  const layoutKeyDep = `${packet?.id}|${packet?.status}|${packet?.processed_at || ''}|${packet?.layout_id || ''}|${packet?.layout_applied_at || ''}|${layoutTick}`;
  useEffect(() => {
    if (!packet?.id || !layoutApi) return;
    let on = true;
    Promise.resolve(layoutApi(`/api/packets/${packet.id}/layout`)).then((r) => { if (on && r && !r.error) setLayoutInfo(r); }).catch(() => {});
    return () => { on = false; };
  }, [layoutKeyDep, layoutApi]); // eslint-disable-line react-hooks/exhaustive-deps
  async function layoutAction(action) {
    if (fields.some((x) => x.dirty) || deleted.length) return setMsg('Save or discard your changes first.');
    if (action === 'dismiss' && typeof window !== 'undefined' && !window.confirm('Remove the fields placed from the saved layout and find fields fresh? Fields you added or edited are kept.')) return;
    setBusy(true); setMsg(null);
    const r = await layoutApi(`/api/packets/${packet.id}/layout`, { method: 'POST', body: JSON.stringify({ action }) });
    setBusy(false);
    if (handle(r)) return;
    if (r?.error) return setMsg(r.error);
    if (r?.fields) { base.current = r.fields; setFields(r.fields); setDeleted([]); setSel(null); if (store) clearDraft(store, packet.id); }
    setLayoutInfo((li) => (li ? { ...li, state: r.state, ...(r.names != null ? { names: r.names } : {}) } : li));
    setMsg(action === 'dismiss' ? (r.redetected ? 'Saved layout removed. Fields were found fresh.' : 'Saved layout removed.')
      : action === 'names' ? `${r.named ?? 0} field name${r.named === 1 ? '' : 's'} copied from last time. Review them before filling.`
      : `Saved layout used. ${r.placed ?? placedCount(r.fields || [])} fields placed. Review them before filling.`);
  }
  const handle = (r) => { if (r?.signedOut) { setSignedOut(true); setMsg(r.error); return true; } return false; };
  useEffect(() => { let on = true; setImg(null); Promise.resolve(renderPage(page)).then((r) => on && setImg(r)); return () => { on = false; }; }, [page, renderPage]);

  const onPage = fields.filter((f) => f.page === page);
  const sum = useMemo(() => summarize(fields), [fields]);
  const status = packetDisplayStatus(filled?.url && !packet.filled_at ? { ...packet, filled_at: 'now' } : packet, fieldSummary(fields));
  const dirty = fields.some((f) => f.dirty) || deleted.length > 0;
  const barShown = actionBarShown({ canEdit, hideActionBar, dirty });
  useEffect(() => { onBarShownChange?.(barShown); }, [barShown, onBarShownChange]);
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
    const r = wrap.current.getBoundingClientRect();
    drag.current = { id: f.id, mode, start: { x: e.clientX, y: e.clientY, left: r.left, top: r.top }, box: f.box, moved: false, dx: 0, dy: 0, k: pxPerCss(wrap.current, img) };
    setDragging(true);
  }
  function moveDrag(e) {
    const d = drag.current; if (!d || !img) return;
    track(d, e);
    if (!d.moved) return;
    if (!raf.current) raf.current = requestAnimationFrame(() => { // one state update per frame: smooth on phones
      raf.current = 0; const c = drag.current; if (!c) return;
      set(c.id, { box: dragBox(c.box, c.mode, c.dx, c.dy, img.w, img.h) });
    });
  }
  // Offset from the ORIGINAL pointerdown point (never from where the tap threshold was crossed).
  function track(d, e) {
    const r = wrap.current.getBoundingClientRect();
    const m = dragDelta(d.start, { x: e.clientX, y: e.clientY, left: r.left, top: r.top }, d.k);
    if (!d.moved && !m.moved) return;
    d.moved = true; d.dx = m.dx; d.dy = m.dy;
  }
  function stopDrag(e) {
    const d = drag.current; drag.current = null; setDragging(false);
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
    if (d && e && Number.isFinite(e.clientX) && e.type === 'pointerup') track(d, e); // final position = where the finger lifted
    if (d?.moved) set(d.id, { box: dragBox(d.box, d.mode, d.dx, d.dy, img.w, img.h) });
    return d;
  }
  function endDrag(e, f) {
    const d = stopDrag(e);
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
    if (res?.fields) { base.current = res.fields; setFields(res.fields); }
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
    setSigMenu(null); setSel(null); setBusy(true); setMsg(null); // clear only; no edit panel
    const r = await onClearSig(id);
    setBusy(false);
    if (handle(r)) return;
    if (r?.error) return setMsg(r.error);
    if (r?.fields) base.current = r.fields;
    if (r?.fields) setFields((fs) => r.fields.map((n) => { const local = fs.find((x) => x.id === n.id && x.dirty); return local ? { ...local, signed: false, signer_name: null, signed_at: null } : n; }));
    setFilled(null);
    const pending = fields.some((x) => x.dirty && x.id !== id) || deleted.length;
    setMsg(pending ? 'Signature cleared. Your other changes are still unsaved: tap Save changes to keep them, or Discard.' : 'Signature cleared.');
  }
  function reSign(id) {
    setSigMenu(null);
    if (fields.some((x) => x.dirty) || deleted.length) return setMsg('Save your changes first, then re-sign.');
    setSigning(id);
  }
  function discard() {
    if (typeof window !== 'undefined' && !window.confirm('Discard your unsaved changes on this packet?')) return;
    if (store) clearDraft(store, packet.id);
    setFields(base.current); setDeleted([]); setSel(null); setSigMenu(null); setSigning(null); setPlacing(false);
    setMsg('Unsaved changes discarded.');
  }
  const blockers = unconfirmedBank(fields);
  const fillWhy = fillBlockers(fields, { dirty });
  async function save() {
    if (blockers.length) { // bank numbers must be confirmed before anything is saved
      const b = blockers[0]; setPage(b.page); setSel(b.id);
      return setMsg(`Confirm the ${KEY_LABELS[b.profile_key].toLowerCase()} first: tick “I checked this number” (or clear the number).`);
    }
    const noName = fields.find((f) => f.dirty && isCustomKey(f.profile_key) && !customName(f.profile_key));
    if (noName) { setPage(noName.page); setSel(noName.id); return setMsg('Type a name for the custom field (or pick another name) before saving.'); }
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
    if (r?.fields) { base.current = r.fields; setFields(r.fields); setDeleted([]); setSel(null); }
  }

  return (
    <main style={{ ...s.main, paddingBottom: barShown ? bottomPadding(bottomReservePx(true, barH)) : COLLAPSED_RESERVE }}>
      <a href="/packets" style={{ fontSize: 14 }}>‹ Packets</a>
      <h1 style={{ fontSize: 20, margin: '0.4rem 0 0', overflowWrap: 'anywhere' }}>{packet.subject || packet.original_filename || 'Carrier packet'}</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: '0.35rem' }}>
        <span data-testid="packet-status" data-status={status.key} style={statusChipStyle(status.color)}>{status.label}</span>
        <span style={{ ...s.muted, margin: 0 }}>{packet.source === 'email' ? 'Emailed' : 'Uploaded'}{packet.created_at ? ` ${formatListTime(packet.created_at)}` : ''}{packet.page_count ? ` · ${packet.page_count} page${packet.page_count === 1 ? '' : 's'}` : ''}</span>
      </div>
      <BrokerField packetId={packet.id} value={brokerName} canEdit={canEdit} api={layoutApi} onSaved={(r) => { setBrokerName(r.broker_name || null); setLayoutTick((n) => n + 1); }} />
      {(() => { const b = layoutBanner(layoutInfo && { ...layoutInfo, broker_name: brokerName ?? layoutInfo.broker_name }, { canEdit, placed: placedCount(fields) }); return b && <div role="status" data-testid="layout-banner" data-kind={b.kind} style={{ ...s.banner, background: '#eff6ff', borderColor: '#93c5fd' }}>
        <p style={{ margin: 0 }}>{b.text}</p>
        {b.action && <button type="button" style={{ ...s.btn, marginTop: 8, ...(b.action === 'apply' || b.action === 'names' ? { background: '#2563eb', color: '#fff', borderColor: '#2563eb' } : null) }} disabled={busy} onClick={() => layoutAction(b.action)}>{b.button}</button>}
      </div>; })()}
      {packet.manual_reason && <p role="status" style={s.banner}>{manualReasonText(packet.manual_reason, canEdit)}</p>}
      {packet.status === 'processing' && <p role="status" style={s.banner}>Finding fields… this usually takes a few seconds.</p>}
      {packet.status === 'archived' && <p role="status" style={s.ro}>This packet is archived. The owner or management can unarchive it from the Packets list.</p>}
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
          return <button key={f.id} data-field={f.id} aria-label={`${rowName(f)}: ${STATE_TEXT[st]}`}
            onClick={(e) => { e.stopPropagation(); if (!canEdit || e.detail === 0) tapField(f); }}
            onPointerDown={canEdit ? (e) => startDrag(e, f, 'move') : undefined} onPointerMove={canEdit ? moveDrag : undefined}
            onPointerUp={canEdit ? (e) => endDrag(e, f) : undefined} onPointerCancel={() => stopDrag()}
            style={{ zIndex: sel === f.id ? 2 : 1, touchAction: canEdit ? 'none' : 'auto', cursor: canEdit ? 'move' : 'pointer', overflow: 'visible', position: 'absolute', left: x0 * scale, top: y0 * scale, width: Math.max(8, (x1 - x0) * scale), height: Math.max(6, (y1 - y0) * scale), border: `2px solid ${STATE_COLORS[st]}`, background: sel === f.id ? `${STATE_COLORS[st]}33` : `${STATE_COLORS[st]}14`, borderRadius: 3, padding: 0, boxSizing: 'border-box', minHeight: 0, minWidth: 0, lineHeight: 1, display: 'block', fontSize: 9, color: STATE_COLORS[st], textAlign: 'left', whiteSpace: 'nowrap' }}>
            {f.signed && sigUrls[f.id]
              ? <img src={sigUrls[f.id]} alt={`Signature of ${f.signer_name || 'signer'}`} draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
              : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', height: '100%' }}>{boxText(f)}</span>}
            {canEdit && sel === f.id && <span role="presentation" data-resize={f.id} onPointerDown={(e) => startDrag(e, f, 'resize')} onPointerMove={moveDrag}
              onPointerUp={(e) => { e.stopPropagation(); stopDrag(e); }} onPointerCancel={(e) => { e.stopPropagation(); stopDrag(); }}
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
      {canEdit && sigMenu && (() => { const f = fields.find((x) => x.id === sigMenu); return f && <section role="dialog" aria-label="Signature options" data-testid="sig-sheet" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60, maxWidth: 560, margin: '0 auto', boxSizing: 'border-box', border: '2px solid #059669', borderBottom: 'none', borderRadius: '12px 12px 0 0', padding: '0.75rem', paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))', background: '#f0fdf4', boxShadow: '0 -6px 20px rgba(0,0,0,0.18)' }}>
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
      {onPage.length === 0 ? <p style={s.muted}>None yet.{canEdit && fields.length === 0 ? ` ${ADD_FIELD_HINT}` : ''}</p> : onPage.map((f) => {
        const st = fieldState(f);
        return <button key={f.id} onClick={() => setSel(f.id)} style={{ ...s.btn, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, textAlign: 'left' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rowName(f)}{f.value && f.profile_key !== SKIP_KEY ? ` · ${f.value}` : ''}</span>
          <span style={s.chip(STATE_COLORS[st])}>{STATE_TEXT[st]}</span></button>;
      })}

      {/* Hidden while the Send-to-broker write/review step is open (it covered Edit / Send now on iPhone), unless
          there are unsaved field edits that still need the Save button. */}
      {barShown && <div ref={bar} data-testid="packet-action-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(var(--nav-h, 0px) + env(safe-area-inset-bottom))', zIndex: 45, background: '#fff', borderTop: '1px solid #e5e7eb', padding: '0.6rem 0.75rem' }}>
        <div style={{ maxWidth: 536, margin: '0 auto' }}>
          {msg ? <p role="status" style={{ margin: '0 0 0.4rem', fontSize: 14 }}>{msg}</p>
            : blockers.length > 0 && <p role="status" style={{ margin: '0 0 0.4rem', fontSize: 14, color: '#b91c1c' }}>{blockers.length === 1 ? '1 bank number needs' : `${blockers.length} bank numbers need`} your confirmation before saving.</p>}
          {filled?.url && <p style={{ margin: '0 0 0.4rem', fontSize: 15 }}><a href={filled.url} download={filled.filename}>⬇ Download filled PDF</a></p>}
          {dirty && <button type="button" style={{ ...s.btn, width: '100%', marginBottom: 6, color: '#b91c1c', borderColor: '#fca5a5' }} disabled={busy} onClick={discard}>Discard changes</button>}
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
      {canEdit && <p data-testid="editor-save-hint" style={{ ...s.muted, fontSize: 13, color: f.dirty ? '#92400e' : '#6b7280' }}>{f.dirty ? 'Changed. Tap Save changes at the bottom to keep it.' : 'Done closes this panel. Tap Save changes at the bottom to keep edits.'}</p>}
      {f.source === 'model' && f.confidence < 0.6 && <p style={{ ...s.muted, color: '#b45309' }}>Low confidence name. Please check it.</p>}
      <label style={s.lab} htmlFor="pf-key">Name</label>
      <select id="pf-key" style={s.input} disabled={dis} value={selectValue(f.profile_key)} onChange={(e) => onChange({ profile_key: keyFromSelect(e.target.value, f) })}>
        <option value="">Choose…</option>
        {nameSelectRows(KEY_LABELS, f.kind).map((o) => o.heading
          ? <option key={o.value} value={o.value} disabled data-heading="1" style={{ fontWeight: 700, color: '#6b7280' }}>{o.label}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {nameGroup(KEY_LABELS, f.kind, f.profile_key) && <p data-testid="name-group" style={{ ...s.muted, fontSize: 13 }}>Group: {nameGroup(KEY_LABELS, f.kind, f.profile_key)}</p>}
      {isCustomKey(f.profile_key) && <>
        <label style={s.lab} htmlFor="pf-custom">{CUSTOM_LABEL}</label>
        <input id="pf-custom" style={s.input} disabled={dis} maxLength={60} placeholder="e.g. Dispatcher name" value={f.profile_key.slice(7)} onChange={(e) => onChange({ profile_key: customKey(e.target.value) })} />
        {!customName(f.profile_key) && <p style={{ ...s.muted, color: '#b45309' }}>Type a name for this field.</p>}
      </>}
      {f.profile_key === SKIP_KEY && <p style={s.muted}>This field will be left blank on the filled PDF.</p>}
      <label style={s.lab} htmlFor="pf-kind">Type</label>
      <select id="pf-kind" style={s.input} disabled={dis} value={f.kind} onChange={(e) => onChange({ kind: e.target.value })}>
        <option value="text">Text</option><option value="date">Date</option><option value="checkbox">Checkbox</option><option value="signature">Signature</option>
      </select>
      <label style={s.lab} htmlFor="pf-label">Label on the form</label>
      <input id="pf-label" style={s.input} disabled={dis} value={f.label || ''} onChange={(e) => onChange({ label: e.target.value })} />
      {f.kind !== 'signature' && f.kind !== 'checkbox' && f.profile_key !== SKIP_KEY && <>
        <label style={s.lab} htmlFor="pf-val">Value{sensitive ? ' (stored encrypted)' : ''}</label>
        <input id="pf-val" style={s.input} disabled={dis} value={f.value || ''} autoComplete="off" inputMode={bank ? 'numeric' : undefined}
          placeholder={sensitive && f.has_value ? 'Saved. Type to replace' : ''} onFocus={(e) => { if (sensitive && /^•/.test(e.target.value)) onChange({ value: '' }); }}
          onChange={(e) => onChange({ value: e.target.value })} />
        {f.check && !f.check.ok && <p style={{ ...s.muted, color: '#b45309' }}>{f.check.message}</p>}
      </>}
      {f.kind === 'signature' && <p style={s.muted}>Tap this signature box on the page to sign it.</p>}
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
