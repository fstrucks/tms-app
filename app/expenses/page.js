'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { fmtMoney } from '../lib/loads';
import { EXPENSE_CATEGORIES, sumAmounts, todayISO, fmtDate } from '../lib/expenses';

const BUCKET = 'documents';
const MAX_BYTES = 10 * 1024 * 1024;
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const ALLOWED_TYPES = Object.values(EXT_TYPES);

function resolveType(file) {
  if (file.type) return file.type;
  return EXT_TYPES[(file.name.split('.').pop() || '').toLowerCase()] || '';
}
const isHeic = (file, type) => type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
async function convertHeicToJpeg(file) {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], file.name.replace(/\.(heic|heif)$/i, '') + '.jpg', { type: 'image/jpeg' });
}

const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.8;

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close?.() };
    } catch (err) { console.warn('[expenses] createImageBitmap failed, falling back to <img>', err); }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image decode failed'));
      i.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Downscale images to ~2000px on the long edge as JPEG 0.8. PDFs pass through.
// Keeps the original if it's already small enough, if the result isn't smaller, or on any failure.
async function downscaleImage(file) {
  if (!file.type.startsWith('image/')) return file;
  let decoded;
  try {
    decoded = await decodeImage(file);
    const { w, h } = decoded;
    if (!w || !h || Math.max(w, h) <= MAX_EDGE) return file;
    const scale = MAX_EDGE / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff'; // flatten transparency for JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(decoded.src, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (err) {
    console.warn('[expenses] downscale failed, keeping original', err);
    return file;
  } finally {
    decoded?.close();
  }
}

const userErr = (msg, detail) => Object.assign(new Error(msg), { user: true, detail });

// Validate + convert + downscale. Runs BEFORE the expense is saved. Returns a File ready to upload.
async function prepareReceipt(file) {
  let up = file;
  const type = resolveType(up);
  if (!ALLOWED_TYPES.includes(type)) throw userErr('Receipt must be a PDF, JPEG, PNG, WebP or HEIC file.');
  if (isHeic(up, type)) {
    try { up = await convertHeicToJpeg(up); }
    catch (err) { throw userErr('Could not convert this iPhone photo (HEIC). Try a JPEG or screenshot.', err); }
  } else if (!up.type) {
    up = new File([up], up.name, { type }); // extension-resolved type, so downscale/upload see it
  }
  up = await downscaleImage(up);
  if (up.size > MAX_BYTES) throw userErr(`Receipt is too large (${(up.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
  return up;
}

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' },
  label: { display: 'block', marginBottom: '0.6rem', fontSize: '0.85rem', color: '#374151' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', fontSize: '1rem', padding: '0.55rem', borderRadius: 8, border: '1px solid #d1d5db', marginTop: '0.2rem', background: '#fff' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff' },
  pick: { minHeight: 48, padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8', touchAction: 'manipulation' },
  small: { padding: '0.4rem 0.75rem', fontSize: '0.85rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  error: { color: '#b91c1c' },
  ok: { color: '#15803d' },
  link: { color: '#2563eb' },
};

const loadLabel = (l) => (l ? `${l.broker_load_number ? '#' + l.broker_load_number : 'Load'}${l.broker_name ? ' · ' + l.broker_name : ''}` : '');
const emptyForm = (loadId = '') => ({ id: null, category: 'fuel', amount: '', expense_date: todayISO(), description: '', load_id: loadId, document_id: null });

function ExpensesInner() {
  const supabase = getSupabase();
  const params = useSearchParams();
  const presetLoad = params.get('load') || '';
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [expenses, setExpenses] = useState([]);
  const [loads, setLoads] = useState([]);
  const [form, setForm] = useState(emptyForm(presetLoad));
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [preview, setPreview] = useState(null);
  const cameraRef = useRef(null);
  const uploadRef = useRef(null);

  // Cheap thumbnail for browser-renderable images (HEIC is converted at save time, so no preview).
  useEffect(() => {
    if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [filterLoad, setFilterLoad] = useState(presetLoad);

  async function fetchAll() {
    const [{ data: e, error: ee }, { data: l, error: le }] = await Promise.all([
      supabase.from('expenses').select('id, load_id, category, amount, description, expense_date, document_id, created_at, documents(id, file_path, original_filename)')
        .order('expense_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('loads').select('id, broker_name, broker_load_number, rate, created_at').order('created_at', { ascending: false }),
    ]);
    const problems = [];
    if (ee) { console.error('[expenses] fetch expenses', ee); problems.push('Could not load expenses. Please refresh.'); }
    else setExpenses(e || []);
    if (le) { console.error('[expenses] fetch loads', le); problems.push('Could not load your loads; load links may be missing. Please refresh.'); }
    else setLoads(l || []);
    return problems;
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && u) setTimeout(async () => { const p = await fetchAll(); if (p.length) setStatus({ type: 'error', text: p.join(' ') }); }, 0);
      if (event === 'SIGNED_OUT') { setExpenses([]); setLoads([]); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Generic message for users; details go to the console.
  function failMsg(text, detail) {
    if (detail) console.error('[expenses]', text, detail);
    setStatus({ type: 'error', text });
  }

  // Upload receipt to documents/{uid}/..., insert documents row (doc_type 'receipt'). Returns { id } or throws.
  async function uploadReceipt(up, loadId) {
    const contentType = up.type || resolveType(up);
    const path = `${user.id}/${Date.now()}-${up.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, up, { contentType });
    if (upErr) throw Object.assign(new Error('Receipt upload failed.'), { detail: upErr });
    const { data, error } = await supabase.from('documents').insert({
      user_id: user.id, load_id: loadId, truck_id: null, doc_type: 'receipt', file_path: path, original_filename: up.name,
    }).select('id').single();
    if (error) {
      // No row was created, so removing the file leaves nothing orphaned.
      await supabase.storage.from(BUCKET).remove([path]);
      throw Object.assign(new Error('Saving receipt failed.'), { detail: error });
    }
    return { id: data.id, path };
  }

  async function submit(e) {
    e.preventDefault();
    setStatus(null);
    const amount = Number(form.amount);
    if (!form.amount || !isFinite(amount) || amount < 0) return setStatus({ type: 'error', text: 'Enter a valid amount.' });
    if (!form.expense_date) return setStatus({ type: 'error', text: 'Pick a date.' });
    if (!EXPENSE_CATEGORIES.includes(form.category)) return setStatus({ type: 'error', text: 'Pick a category.' });
    setSaving(true);
    // Validate/convert/downscale the receipt first: a bad or oversized file stops the save entirely.
    let prepared = null;
    if (file) {
      try { prepared = await prepareReceipt(file); }
      catch (err) {
        setSaving(false);
        if (!err.user || err.detail) console.error('[expenses] prepare receipt', err.detail || err);
        return setStatus({ type: 'error', text: err.user ? err.message : "Couldn't process the receipt. Please try another file." });
      }
    }
    const editing = !!form.id;
    try {
      const loadId = form.load_id || null;
      const row = {
        category: form.category,
        amount: Math.round(amount * 100) / 100,
        expense_date: form.expense_date,
        description: form.description.trim() || null,
        load_id: loadId,
      };
      // 1. Save the expense first, so a failure here never leaves a receipt behind.
      const { data: saved, error } = editing
        ? await supabase.from('expenses').update(row).eq('id', form.id).select('id').single()
        : await supabase.from('expenses').insert({ ...row, user_id: user.id }).select('id').single();
      if (error || !saved) return failMsg('Could not save the expense. Please try again.', error);

      const warnings = [];
      // 2. Keep the existing receipt's load link in sync when the load changes.
      const prevLoad = editing ? (expenses.find((x) => x.id === form.id)?.load_id || null) : null;
      if (editing && form.document_id && !file && prevLoad !== loadId) {
        const { data: upd, error: ue } = await supabase.from('documents').update({ load_id: loadId }).eq('id', form.document_id).select('id');
        if (ue || !upd?.length) { console.error('[expenses] receipt load sync', ue || 'no row updated'); warnings.push("the receipt's load link wasn't updated"); }
      }
      // 3. Attach a new receipt: upload + documents row, then link it.
      if (prepared) {
        try {
          const receipt = await uploadReceipt(prepared, loadId);
          const { data: linked, error: le } = await supabase.from('expenses').update({ document_id: receipt.id }).eq('id', saved.id).select('id');
          if (le || !linked?.length) {
            console.error('[expenses] link receipt', le || 'no row updated');
            // Only remove the file if the documents row was really deleted (RLS may silently block it).
            const { data: del } = await supabase.from('documents').delete().eq('id', receipt.id).select('id');
            if (del?.length) await supabase.storage.from(BUCKET).remove([receipt.path]);
            else console.error('[expenses] unlinked receipt document left in place', receipt.id);
            warnings.push("the receipt couldn't be attached");
          }
        } catch (err) {
          if (err.detail || !err.user) console.error('[expenses]', err.message, err.detail || err);
          warnings.push(err.user ? err.message : "the receipt couldn't be uploaded");
        }
      }
      const saveMsg = warnings.length
        ? `Expense saved, but ${warnings.join(' and ')}. You can edit it to try again.`
        : (editing ? 'Expense updated.' : 'Expense added.');
      setForm(emptyForm(editing ? presetLoad : form.load_id));
      setFile(null); setFileKey((k) => k + 1);
      // Refresh, but never let a refresh error hide the save result: show both.
      const problems = await fetchAll();
      setStatus(warnings.length || problems.length
        ? { type: 'error', text: [saveMsg, ...problems].join(' ') }
        : { type: 'ok', text: saveMsg });
    } catch (err) {
      failMsg('Something went wrong. Please try again.', err);
    } finally {
      setSaving(false);
    }
  }

  function edit(x) {
    setForm({ id: x.id, category: x.category || 'other', amount: String(x.amount ?? ''), expense_date: x.expense_date || todayISO(), description: x.description || '', load_id: x.load_id || '', document_id: x.document_id });
    setFile(null); setFileKey((k) => k + 1); setStatus(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function remove(x) {
    if (!window.confirm('Delete this expense?')) return;
    const { error } = await supabase.from('expenses').delete().eq('id', x.id);
    if (error) return failMsg('Could not delete the expense. Please try again.', error);
    if (form.id === x.id) setForm(emptyForm(presetLoad));
    const problems = await fetchAll();
    if (problems.length) setStatus({ type: 'error', text: problems.join(' ') });
  }

  async function viewReceipt(doc) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
    if (error) return failMsg('Could not open the receipt. Please try again.', error);
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  const loadById = Object.fromEntries(loads.map((l) => [l.id, l]));
  const shown = filterLoad ? expenses.filter((x) => x.load_id === filterLoad) : expenses;
  const filterRate = filterLoad ? loadById[filterLoad]?.rate : null;

  return (
    <main style={s.main}>
      <p style={{ display: 'flex', gap: '1rem' }}>
        <Link href="/" style={s.link}>← Home</Link>
        <Link href="/loads" style={s.link}>Loads</Link>
      </p>
      <h1 style={{ fontSize: '1.5rem' }}>Expenses</h1>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <Link href="/login" style={s.link}>sign in</Link> to track expenses.</p>
        : (
          <>
            <form onSubmit={submit} style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>{form.id ? 'Edit expense' : 'Add expense'}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 0.6rem' }}>
                <label style={s.label}>Category
                  <select value={form.category} onChange={set('category')} style={s.input}>
                    {!EXPENSE_CATEGORIES.includes(form.category) && <option value={form.category}>{form.category}</option>}
                    {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </label>
                <label style={s.label}>Amount ($)
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={form.amount} onChange={set('amount')} style={s.input} required />
                </label>
              </div>
              <label style={s.label}>Date
                <input type="date" value={form.expense_date} onChange={set('expense_date')} style={s.input} required />
              </label>
              <label style={s.label}>Vendor / description
                <input type="text" value={form.description} onChange={set('description')} placeholder="e.g. Pilot #123, I-80 tolls" style={s.input} />
              </label>
              <label style={s.label}>Load (optional)
                <select value={form.load_id} onChange={set('load_id')} style={s.input}>
                  <option value="">— Not linked —</option>
                  {form.load_id && !loadById[form.load_id] && <option value={form.load_id}>Linked load</option>}
                  {loads.map((l) => <option key={l.id} value={l.id}>{loadLabel(l)} · {new Date(l.created_at).toLocaleDateString()}</option>)}
                </select>
              </label>
              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 0.6rem', minWidth: 0 }} disabled={saving}>
                <legend style={{ ...s.label, padding: 0, marginBottom: 0 }}>Receipt (optional){form.document_id && !file ? ' · one attached, choose a file to replace' : ''}</legend>
                {/* Both hidden inputs feed the same file state and receipt flow (validate, HEIC conversion, downscale, 10 MB limit). */}
                <input key={`cam-${fileKey}`} ref={cameraRef} type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
                <input key={`up-${fileKey}`} ref={uploadRef} type="file" accept="application/pdf,image/*,.heic,.heif" tabIndex={-1} aria-hidden="true" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.3rem' }}>
                  <button type="button" onClick={() => cameraRef.current?.click()} disabled={saving} style={{ ...s.pick, opacity: saving ? 0.6 : 1 }}><span aria-hidden="true">📷 </span>Take photo</button>
                  <button type="button" onClick={() => uploadRef.current?.click()} disabled={saving} style={{ ...s.pick, opacity: saving ? 0.6 : 1 }}><span aria-hidden="true">📎 </span>Upload file</button>
                </div>
                <div aria-live="polite" aria-atomic="true">
                  {file && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
                      {preview && <img src={preview} alt="Receipt preview" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb', flexShrink: 0 }} />}
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#111827' }}>
                        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Selected receipt: </span>{file.name}
                      </span>
                      <button type="button" disabled={saving} onClick={() => { setFile(null); setFileKey((k) => k + 1); }} style={{ ...s.small, minWidth: 44, minHeight: 44, opacity: saving ? 0.6 : 1 }} aria-label="Remove selected receipt">✕</button>
                    </div>
                  )}
                </div>
              </fieldset>
              <button type="submit" disabled={saving} style={{ ...s.btn, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add expense'}
              </button>
              {form.id && <button type="button" onClick={() => { setForm(emptyForm(presetLoad)); setFile(null); setFileKey((k) => k + 1); }} style={{ ...s.small, width: '100%', marginTop: '0.5rem' }}>Cancel edit</button>}
              {status && <p style={status.type === 'error' ? s.error : s.ok}>{status.text}</p>}
            </form>

            <div style={{ ...s.row, marginBottom: '0.5rem' }}>
              <select value={filterLoad} onChange={(e) => setFilterLoad(e.target.value)} style={{ ...s.input, marginTop: 0, maxWidth: '60%' }}>
                <option value="">All expenses</option>
                {loads.map((l) => <option key={l.id} value={l.id}>{loadLabel(l)}</option>)}
              </select>
              <strong>{fmtMoney(sumAmounts(shown))}</strong>
            </div>
            {filterLoad && filterRate != null && (
              <p style={{ ...s.muted, textAlign: 'right', marginTop: 0 }}>Rate {fmtMoney(filterRate)} · Net <strong>{fmtMoney(Number(filterRate) - sumAmounts(shown))}</strong></p>
            )}

            {shown.length === 0 ? <p style={s.muted}>No expenses yet.</p> : shown.map((x) => (
              <div key={x.id} style={s.card}>
                <div style={s.row}>
                  <strong style={{ textTransform: 'capitalize' }}>{x.category}</strong>
                  <strong>{fmtMoney(x.amount)}</strong>
                </div>
                {x.description && <div style={{ margin: '0.25rem 0', fontSize: '0.9rem', wordBreak: 'break-word' }}>{x.description}</div>}
                <div style={s.muted}>
                  {fmtDate(x.expense_date)}
                  {x.load_id && <> · <Link href={`/loads/${x.load_id}`} style={s.link}>{loadLabel(loadById[x.load_id]) || 'Load'}</Link></>}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button onClick={() => edit(x)} style={s.small}>Edit</button>
                  {x.documents?.file_path && <button onClick={() => viewReceipt(x.documents)} style={s.small}>Receipt</button>}
                  <button onClick={() => remove(x)} style={{ ...s.small, color: '#b91c1c' }}>Delete</button>
                </div>
              </div>
            ))}
          </>
        )}
    </main>
  );
}

export default function ExpensesPage() {
  return <Suspense fallback={null}><ExpensesInner /></Suspense>;
}
