'use client';

import { authedFetch } from '../lib/authedFetch';
import { deleteExpense } from '../lib/expenseDelete';
import { Suspense, useEffect, useRef, useState } from 'react';
import UploadMenu from '../components/UploadMenu';
import Link from 'next/link';
import SignInLink from '../components/SignInLink';
import { useSearchParams } from 'next/navigation';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { fmtMoney, moneyInput } from '../lib/money';
import { Loading, LoadError } from '../components/DataState';
import { EXPENSE_CATEGORIES, sumAmounts, todayISO, fmtDate } from '../lib/expenses';

const BUCKET = 'documents';
const MAX_BYTES = 10 * 1024 * 1024;
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const ALLOWED_TYPES = Object.values(EXT_TYPES);

function resolveType(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  // Never accept SVG (scriptable), whatever the extension or declared type says.
  if (ext === 'svg' || type.includes('svg')) return 'image/svg+xml';
  if (Object.values(EXT_TYPES).includes(type)) return type;
  // Declared type missing or not allowed (e.g. HEIC as octet-stream on Android): fall back to the extension.
  return EXT_TYPES[ext] || type;
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

// The AI route accepts at most 4.5 MB (Vercel body limit); aim for 4 MB to leave multipart headroom.
// The saved receipt is unaffected: only the copy sent for reading is recompressed.
// Decodes the image ONCE, then tries progressively smaller JPEG encodes.
const AI_MAX_BYTES = 4 * 1024 * 1024;
async function fitForAi(file) {
  if (file.size <= AI_MAX_BYTES) return file;
  let decoded;
  try {
    decoded = await decodeImage(file);
    const { w, h } = decoded;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    for (const [edge, q] of [[2000, 0.7], [1600, 0.6], [1280, 0.5]]) {
      const scale = Math.min(1, edge / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(decoded.src, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
      if (blob && blob.size <= AI_MAX_BYTES) return new File([blob], name, { type: 'image/jpeg' });
    }
    return null;
  } catch (err) {
    console.warn('[expenses] re-encode failed', err);
    return null;
  } finally {
    decoded?.close();
  }
}

const sameFile = (a, b) => !!a && !!b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

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
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' },
  label: { display: 'block', marginBottom: '0.6rem', fontSize: '0.85rem', color: 'var(--text)' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', fontSize: '1rem', padding: '0.55rem', borderRadius: 8, border: '1px solid var(--border)', marginTop: '0.2rem', background: 'var(--surface)' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' },
  auto: { background: 'var(--warning-bg)', borderColor: 'var(--warning)', boxShadow: '0 0 0 1px var(--warning)' },
  sticky: { position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', zIndex: 10, background: 'var(--surface)', padding: '0.6rem 0 0.4rem', marginTop: '0.25rem' },
  small: { minHeight: 44, padding: '0.4rem 0.85rem', fontSize: '0.85rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  error: { color: 'var(--danger)' },
  ok: { color: 'var(--success)' },
  link: { color: 'var(--primary)' },
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
  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const fetchReqRef = useRef(0);
  const [listErr, setListErr] = useState(null);   // expenses / session problem (one message, with Retry)
  const [loadsErr, setLoadsErr] = useState(false); // loads query failed (load links may be missing)
  const listReadyRef = useRef(false);
  listReadyRef.current = listState === 'ready';
  const [form, setForm] = useState(emptyForm(presetLoad));
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [preview, setPreview] = useState(null);

  // Cheap thumbnail for browser-renderable images (HEIC is converted at save time, so no preview).
  useEffect(() => {
    if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [saving, setSaving] = useState(false);
  // AI auto-fill state. touched = fields the user deliberately changed since the form opened; those are
  // never overwritten. On a new expense, category/date (defaults) can be filled unless touched; amount/
  // description when empty or still holding a previous auto-fill. Editing an existing expense marks all touched.
  const [ai, setAi] = useState({ state: 'idle', text: '' });
  const [autoFilled, setAutoFilled] = useState(() => new Set());
  const touchedRef = useRef(new Set());
  const autoFilledRef = useRef(new Set());
  const preparedRef = useRef(null); // { src: File, out: File } so save reuses the converted/downscaled image
  const aiReqRef = useRef(0);
  const formRef = useRef(form);
  formRef.current = form;
  const [status, setStatus] = useState(null);
  const [filterLoad, setFilterLoad] = useState(presetLoad);

  async function fetchAll() {
    const req = ++fetchReqRef.current;
    if (!listReadyRef.current) setListState('loading');
    if (!(await hasSession(supabase))) {
      if (req === fetchReqRef.current) {
        setListErr('Your session has expired or is still loading. Tap Retry, or sign in again.');
        setListState((st) => (st === 'ready' ? 'ready' : 'error'));
      }
      return ['__list'];
    }
    const [{ data: e, error: ee }, { data: l, error: le }] = await Promise.all([
      supabase.from('expenses').select('id, load_id, category, amount, description, expense_date, document_id, created_at, documents(id, file_path, original_filename)')
        .order('expense_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('loads').select('id, broker_name, broker_load_number, rate, created_at').order('created_at', { ascending: false }),
    ]);
    if (req !== fetchReqRef.current) return []; // superseded by a newer fetch
    const problems = [];
    // Problems are shown once, in the banners above the list (with Retry). The return value only tells
    // callers (e.g. the post-save refresh) that something failed.
    if (ee) {
      console.error('[expenses] fetch expenses', ee);
      problems.push('__list');
      setListErr(listReadyRef.current ? "Couldn't refresh. Showing the last loaded expenses." : "Couldn't load your expenses.");
      setListState((st) => (st === 'ready' ? 'ready' : 'error'));
    } else { setListErr(null); setExpenses(e || []); setListState('ready'); }
    if (le) { console.error('[expenses] fetch loads', le); problems.push('__loads'); setLoadsErr(true); }
    else { setLoadsErr(false); setLoads(l || []); }
    return problems;
  }

  // Retry clears both the expenses/session and the loads errors, then re-runs fetchAll.
  function retryFetch() { setListErr(null); setLoadsErr(false); fetchAll(); }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      // Fetch only once a session exists; re-fetch when it changes (or after a refresh if nothing loaded yet).
      if ((['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED'].includes(event) || (event === 'TOKEN_REFRESHED' && !listReadyRef.current)) && u) {
        setTimeout(() => fetchAll(), 0);
      }
      if (event === 'SIGNED_OUT') { fetchReqRef.current++; setExpenses([]); setLoads([]); setListState('loading'); setListErr(null); setLoadsErr(false); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const set = (k) => (e) => {
    touchedRef.current.add(k);
    autoFilledRef.current.delete(k);
    setAutoFilled((s0) => { if (!s0.has(k)) return s0; const n = new Set(s0); n.delete(k); return n; });
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  function resetAi(touched = []) {
    aiReqRef.current += 1; // cancels any in-flight read
    preparedRef.current = null;
    touchedRef.current = new Set(touched);
    autoFilledRef.current = new Set();
    setAutoFilled(new Set());
    setAi({ state: 'idle', text: '' });
  }

  function clearReceipt() {
    aiReqRef.current += 1;
    preparedRef.current = null;
    setAi({ state: 'idle', text: '' });
    setFile(null); setFileKey((k) => k + 1);
  }

  function pickFile(f) {
    // Re-picking the same file (name, size, lastModified) keeps the current file and auto-fill result.
    if (f && sameFile(f, file)) return;
    aiReqRef.current += 1;
    preparedRef.current = null;
    setAi({ state: 'idle', text: '' });
    setFile(f);
    if (f) autoFill(f);
  }

  // After pick: convert/downscale (same as save), send to /api/extract-receipt, prefill empty fields only.
  async function autoFill(f) {
    const req = aiReqRef.current;
    const stale = () => req !== aiReqRef.current;
    const type = resolveType(f);
    if (type === 'application/pdf') return setAi({ state: 'error', text: 'PDF receipts can’t be read automatically yet. Please enter the details.' });
    if (!type.startsWith('image/')) return; // prepare/save will report the type error
    setAi({ state: 'reading', text: 'Reading receipt…' });
    let prepared;
    try {
      prepared = await prepareReceipt(f);
    } catch (err) {
      if (stale()) return;
      if (!err.user || err.detail) console.error('[expenses] auto-fill prepare', err.detail || err);
      return setAi({ state: 'error', text: err.user ? err.message : "Couldn't read this receipt. Please enter the details manually." });
    }
    if (stale()) return;
    preparedRef.current = { src: f, out: prepared };
    if (!/^image\/(jpeg|png|webp)$/.test(prepared.type)) return setAi({ state: 'error', text: "This image type can't be read automatically. Please enter the details." });
    const forAi = await fitForAi(prepared);
    if (stale()) return;
    if (!forAi) return setAi({ state: 'error', text: 'This photo is too large to read automatically. Please enter the details manually.' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const body = new FormData();
      body.append('file', forAi, forAi.name);
      body.append('today', todayISO());
      const res = await authedFetch(supabase.auth, '/api/extract-receipt', { method: 'POST', body, signal: ac.signal });
      if (stale()) return;
      const out = await res.json().catch(() => ({}));
      if (stale()) return;
      if (!res.ok || !out.data) {
        console.error('[expenses] auto-fill', res.status, out?.error);
        const msg = res.status === 401 ? 'Sign in again to auto-fill from receipts.'
          : [400, 413, 415, 429, 501].includes(res.status) && out?.error ? out.error
          : "Couldn't read this receipt.";
        return setAi({ state: 'error', text: /manually\.?$/.test(msg) ? msg : `${msg} You can enter the details manually.` });
      }
      applyAutoFill(out.data);
    } catch (err) {
      if (stale()) return;
      console.error('[expenses] auto-fill request', err);
      setAi({ state: 'error', text: err.name === 'AbortError' ? 'Reading the receipt took too long. Please enter the details manually.' : "Couldn't reach the receipt reader. Please enter the details manually." });
    } finally {
      clearTimeout(timer);
    }
  }

  function applyAutoFill(d) {
    if (!d.is_receipt) return setAi({ state: 'error', text: "This doesn't look like a readable receipt. Please enter the details manually." });
    const desc = [d.vendor, d.description].filter(Boolean).join(' — ').slice(0, 200);
    const proposal = {
      amount: d.amount != null ? moneyInput(d.amount) : null,
      expense_date: d.expense_date,
      category: EXPENSE_CATEGORIES.includes(d.category) ? d.category : null,
      description: desc || null,
    };
    const isOpen = (f, k) => {
      if (touchedRef.current.has(k)) return false;
      if (k === 'amount' || k === 'description') return f[k] === '' || autoFilledRef.current.has(k);
      return true; // category / date on a new expense: defaults until the user changes them
    };
    const cur = formRef.current;
    const patch = {};
    for (const [k, v] of Object.entries(proposal)) if (v != null && isOpen(cur, k) && cur[k] !== v) patch[k] = v;
    const keys = Object.keys(patch);
    console.info('[expenses] auto-fill', { proposal: { expense_date: proposal.expense_date, category: proposal.category }, filled: keys, touched: [...touchedRef.current] });
    if (!keys.length) return setAi({ state: 'done', text: 'Receipt read, but nothing new to fill. Your entries were kept.' });
    // Re-check inside the updater so a keystroke between read and apply is never overwritten.
    setForm((f) => { const n = { ...f }; for (const k of keys) if (isOpen(f, k)) n[k] = patch[k]; return n; });
    // Only fields whose value actually came from this receipt are marked.
    for (const k of keys) autoFilledRef.current.add(k);
    setAutoFilled(new Set(autoFilledRef.current));
    const low = d.confidence != null && d.confidence < 0.6;
    setAi({ state: 'done', text: `Auto-filled ${keys.map((k) => ({ amount: 'amount', expense_date: 'date', category: 'category', description: 'vendor/description' }[k])).join(', ')}. Please check${low ? ' carefully, the receipt was hard to read' : ''}.` });
  }

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
    if (ai.state === 'reading') return; // Save is disabled while reading; guard Enter-key submits too.
    setStatus(null);
    const amount = Number(form.amount);
    if (!form.amount || !isFinite(amount) || amount < 0) return setStatus({ type: 'error', text: 'Enter a valid amount.' });
    if (!form.expense_date) return setStatus({ type: 'error', text: 'Pick a date.' });
    if (!EXPENSE_CATEGORIES.includes(form.category)) return setStatus({ type: 'error', text: 'Pick a category.' });
    setSaving(true);
    // Validate/convert/downscale the receipt first: a bad or oversized file stops the save entirely.
    let prepared = null;
    if (file) {
      try { prepared = preparedRef.current?.src === file ? preparedRef.current.out : await prepareReceipt(file); }
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
      setForm(emptyForm(presetLoad)); // Load resets too, except a ?load=<id> preselection
      setFile(null); setFileKey((k) => k + 1); resetAi();
      // Refresh, but never let a refresh error hide the save result: show both.
      // A refresh failure shows in its own banner above the list (with Retry), so the save result stays visible too.
      await fetchAll();
      setStatus({ type: warnings.length ? 'error' : 'ok', text: saveMsg });
    } catch (err) {
      failMsg('Something went wrong. Please try again.', err);
    } finally {
      setSaving(false);
    }
  }

  function edit(x) {
    setForm({ id: x.id, category: x.category || 'other', amount: moneyInput(x.amount), expense_date: x.expense_date || todayISO(), description: x.description || '', load_id: x.load_id || '', document_id: x.document_id });
    setFile(null); setFileKey((k) => k + 1); setStatus(null); resetAi(['category', 'expense_date']); // editing: keep saved category/date; blanks may fill
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function remove(x) {
    if (!window.confirm('Delete this expense?')) return;
    const r = await deleteExpense(supabase, x, BUCKET); // its receipt goes too when no other expense uses it
    if (!r.ok) return failMsg('Could not delete the expense. Please try again.', r.error);
    if (r.warning) console.warn('[expenses] receipt', r.warning);
    if (form.id === x.id) { setForm(emptyForm(presetLoad)); clearReceipt(); resetAi(); }
    await fetchAll(); // refresh problems show in the banner above the list
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
      <h1 style={{ fontSize: '1.5rem' }}>Expenses</h1>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to track expenses.</p>
        : (
          <>
            <form onSubmit={submit} style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>{form.id ? 'Edit expense' : 'Add expense'}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 0.6rem' }}>
                <label style={s.label}>Category
                  <select value={form.category} onChange={set('category')} style={{ ...s.input, ...(autoFilled.has('category') ? s.auto : null) }}>
                    {!EXPENSE_CATEGORIES.includes(form.category) && <option value={form.category}>{form.category}</option>}
                    {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
                  </select>
                </label>
                <label style={s.label}>Amount ($)
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={form.amount} onChange={set('amount')} style={{ ...s.input, ...(autoFilled.has('amount') ? s.auto : null) }} required />
                </label>
              </div>
              <label style={s.label}>Date
                <input type="date" value={form.expense_date} onChange={set('expense_date')} style={{ ...s.input, ...(autoFilled.has('expense_date') ? s.auto : null) }} required />
              </label>
              <label style={s.label}>Vendor / description
                <input type="text" value={form.description} onChange={set('description')} placeholder="e.g. Pilot #123, I-80 tolls" style={{ ...s.input, ...(autoFilled.has('description') ? s.auto : null) }} />
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
                {/* One menu (Take photo / Photo library / Files-PDF) feeds the same file state and receipt flow (validate, HEIC conversion, downscale, 10 MB limit). */}
                <div style={{ marginTop: '0.3rem' }}><UploadMenu key={`menu-${fileKey}`} onFile={pickFile} disabled={saving || ai.state === 'reading'} /></div>
                <div aria-live="polite" aria-atomic="true">
                  {file && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
                      {preview && <img src={preview} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--divider)', flexShrink: 0 }} />}
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                        <span style={{ position: 'absolute', width: 1, height: 1, margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Selected receipt: </span>{file.name}
                      </span>
                      <button type="button" disabled={saving} onClick={clearReceipt} style={{ ...s.small, minWidth: 44, minHeight: 44, opacity: saving ? 0.6 : 1 }} aria-label="Remove selected receipt">✕</button>
                    </div>
                  )}
                </div>
                <div role="status" aria-live="polite" aria-atomic="true">
                  {ai.state !== 'idle' && (
                    <p style={{ margin: '0.5rem 0 0', padding: '0.5rem 0.6rem', borderRadius: 8, fontSize: '0.9rem',
                      background: ai.state === 'done' ? 'var(--warning-bg)' : ai.state === 'error' ? 'var(--surface-2)' : 'var(--info-bg)',
                      color: ai.state === 'done' ? 'var(--warning)' : ai.state === 'error' ? 'var(--text)' : 'var(--primary)' }}>
                      {ai.state === 'reading' && <span aria-hidden="true">⏳ </span>}{ai.text}
                    </p>
                  )}
                </div>
              </fieldset>
              <div style={s.sticky} data-upload-avoid>
              <button type="submit" disabled={saving || ai.state === 'reading'} aria-describedby={ai.state === 'reading' ? 'save-hint' : undefined}
                style={{ ...s.btn, opacity: saving || ai.state === 'reading' ? 0.6 : 1 }}>
                {saving ? 'Saving…' : ai.state === 'reading' ? 'Reading receipt…' : form.id ? 'Save changes' : 'Add expense'}
              </button>
              {ai.state === 'reading' && <p id="save-hint" style={{ ...s.muted, margin: '0.35rem 0 0', textAlign: 'center' }}>Save is available once the receipt has been read (or remove it with ✕).</p>}
              </div>
              {form.id && <button type="button" onClick={() => { setForm(emptyForm(presetLoad)); clearReceipt(); resetAi(); }} style={{ ...s.small, width: '100%', marginTop: '0.5rem' }}>Cancel edit</button>}
              {status && <p style={status.type === 'error' ? s.error : s.ok}>{status.text}</p>}
            </form>

            {listErr && <LoadError message={listErr} subtle={listState === 'ready'} onRetry={retryFetch} />}
            {loadsErr && !listErr && <LoadError subtle message="Couldn't load your loads; load links may be missing." onRetry={retryFetch} />}
            {listState === 'loading' && <Loading label="Loading expenses…" />}
            {listState === 'ready' && (<>
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
                  <button onClick={() => remove(x)} style={{ ...s.small, color: 'var(--danger)' }}>Delete</button>
                </div>
              </div>
            ))}
            </>)}
          </>
        )}
    </main>
  );
}

export default function ExpensesPage() {
  return <Suspense fallback={null}><ExpensesInner /></Suspense>;
}
