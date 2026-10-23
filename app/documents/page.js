'use client';

import { authedFetch } from '../lib/authedFetch';
import { docTypeLabel } from '../lib/docTypes';
import { useEffect, useRef, useState } from 'react';
import UploadMenu from '../components/UploadMenu';
import { extractedWeightLb } from '../lib/loadWeight';
import { extractedMiles, fillLinkedLoadMiles } from '../lib/loadMiles';
import { notifyLoadChanged } from '../lib/loadSync';
import { UPLOAD_TYPES, CHANGE_TYPES, DOCUMENTS_SCAN_TYPE_IDS, isDocumentsTabDoc, isCompanyDocType, uploadTypeFromQuery, canChangeDocType, saveDocType } from '../lib/docTypes';
import dynamic from 'next/dynamic';

// Scanner (and pdf-lib) load only when "Scan document" is used.
import DocLoadLink from '../components/DocLoadLink';
import TeamDocsList from '../components/TeamDocsList';
import { fetchVisibleLoads } from '../lib/visibleLoads';
import { isLoadDocType, suggestLoad, loadForSuggest, loadPickLabel } from '../lib/loadDocs';
const Scanner = dynamic(() => import('../components/scanner/Scanner'), { ssr: false, loading: () => null });
import Link from 'next/link';
import SignInLink from '../components/SignInLink';
import { useRouter } from 'next/navigation';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { fmtMoney } from '../lib/money';
import { uploadScan } from '../lib/scanUpload';
import { Loading, LoadError } from '../components/DataState';
import ConfirmButton from '../components/ui/ConfirmButton';
import { deleteDocument, deletePrompt } from '../lib/documents';
import RateconEmailCard from '../components/RateconEmailCard';
import { emailDraftState, emailReadProblem, isEmailDraft, isNotRatecon, skippedLine, readDismissed, addDismissed, visibleSkipped, fetchSkipped, createLoadFromDoc, teammateEmailDoc, uploadProfileFor } from '../lib/rateconDrafts';
import { fetchActiveCompany } from '../lib/activeCompanyClient';
import { INBOX_RECENT_CAP, INBOX_RECENT_DAYS, INBOX_WAITING_CAP, fetchWaitingRateCons, mergeInboxDocs, readInboxOpen, writeInboxOpen } from '../lib/docsInbox';
import VaultTiles from '../components/VaultTiles';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

// Browsers often report an empty (or generic) type for HEIC and some Android picks, so fall back to the extension.
function resolveType(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  // Never accept SVG (scriptable), whatever the extension or declared type says.
  if (ext === 'svg' || type.includes('svg')) return 'image/svg+xml';
  if (ALLOWED_TYPES.includes(type)) return type;
  // Declared type missing or not allowed (e.g. HEIC as octet-stream on Android): fall back to the extension.
  return EXT_TYPES[ext] || type;
}

const BUCKET = 'documents';
// Only rate confirmations are AI-extracted / turned into loads; scanned docs (BOL, POD, etc.) are stored as-is.
const EXTRACTABLE = (t) => !t || t === 'rate_confirmation';

function isHeic(file, type) {
  return type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
}

// Convert HEIC/HEIF to JPEG in the browser. heic2any is loaded only when needed (client only).
async function convertHeicToJpeg(file) {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  const name = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', marginTop: '0.75rem' },
  input: { width: '100%', fontSize: '1rem' },
  item: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 0', borderBottom: '1px solid var(--divider)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  error: { color: 'var(--danger)' },
  ok: { color: 'var(--success)' },
  badge: { display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: 'var(--primary)', color: 'var(--on-primary)', marginRight: 6 },
  tap: { display: 'inline-flex', alignItems: 'center', minHeight: 44 },
};
const DOC_COLS = 'id, user_id, doc_type, file_path, original_filename, created_at, ai_extracted_data, load_id';
const EMAIL_COLS = 'source, extraction_status, extraction_error';

export default function DocumentsPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [scanFiles, setScanFiles] = useState(null); // photos that opened the scanner
  const [scanLoads, setScanLoads] = useState([]);
  const [scanLoadId, setScanLoadId] = useState('');
  const [checking, setChecking] = useState(true);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // remounts the hidden inputs to clear them

  // Both pickers feed the same state. Validate the real type/extension right away (the simple
  // accept list no longer filters, so unsupported files are caught here).
  // Upload type: rate confirmation (default; AI extraction, and COIs are auto-detected) or a fixed type.
  // ?type=<id> presets an upload type (company types moved to Company → Company documents in PR #84).
  const [uploadType, setUploadType] = useState('rate_confirmation');
  // Change type on saved documents: owner/management only (server enforces). Never re-runs extraction by itself.
  const [canChangeType, setCanChangeType] = useState(false);
  // PR #110: drivers don't upload rate cons (they carry the rate) and don't get the ratecon@ email card.
  const [isDriver, setIsDriver] = useState(false);
  const skipScopeRef = useRef({ role: null, ownerId: null, companyId: null }); // banners: owner/management/dispatcher of this company only
  const [typeBusy, setTypeBusy] = useState({});
  const [typeChanged, setTypeChanged] = useState({}); // id → true after a change to rate con ("Read as rate con" offered)
  useEffect(() => { (async () => {
    const t = (await supabase?.auth.getSession())?.data?.session?.access_token; if (!t) return;
    const j = await fetch('/api/company-profile', { cache: 'no-store', headers: { Authorization: `Bearer ${t}` } }).then((x) => x.json()).catch(() => ({}));
    setCanChangeType(canChangeDocType(j.role));
    skipScopeRef.current = { role: j.role || null, ownerId: j.profile?.owner_id || null, companyId: j.profile?.id || null, userId: user?.id || null };
    loadSkipped();
    if (j.role === 'driver') { setIsDriver(true); setUploadType((t) => (t === 'rate_confirmation' ? 'bol' : t)); }
  })(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [typeErr, setTypeErr] = useState({}); // id → { error, docType } after a failed save (old type kept)
  async function changeType(d, docType) {
    if (typeBusy[d.id] || docType === d.doc_type) return;
    setTypeBusy((m) => ({ ...m, [d.id]: true }));
    setTypeErr((m) => ({ ...m, [d.id]: null }));
    const t = (await supabase.auth.getSession())?.data?.session?.access_token;
    const r = await saveDocType({ id: d.id, docType, token: t });
    setTypeBusy((m) => ({ ...m, [d.id]: false }));
    // Failure: the row keeps the old type (select is controlled by d.doc_type, which we don't touch).
    if (!r.ok) return setTypeErr((m) => ({ ...m, [d.id]: { error: r.error, docType } }));
    // PR #84: a company type moves the file to Company → Company documents, so it leaves this list.
    if (isCompanyDocType(r.docType)) {
      setDocs((list) => list.filter((x) => x.id !== d.id));
      return setStatus({ type: 'ok', text: `Saved as ${docTypeLabel(r.docType)} and moved to Company → Company documents.` });
    }
    setDocs((list) => list.map((x) => (x.id === d.id ? { ...x, doc_type: r.docType } : x)));
    setTypeChanged((m) => ({ ...m, [d.id]: r.offerRead }));
    setStatus({ type: 'ok', text: `Saved as ${docTypeLabel(r.docType)}.${r.offerRead ? ' Tap “Read as rate con” if you want the load details read.' : ''}` });
  }
  useEffect(() => { const t = uploadTypeFromQuery(window.location.search); if (t) setUploadType(t); }, []);

  function pickFile(f) {
    if (!f) return;
    const type = resolveType(f);
    if (!ALLOWED_TYPES.includes(type)) {
      setFile(null); setFileKey((k) => k + 1);
      return setStatus({ type: 'error', text: 'Unsupported file type. Use PDF, JPEG, PNG, WebP or HEIC/HEIF.' });
    }
    setStatus(null);
    setFile(f);
  }
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState(false);
  const router = useRouter();
  const [creating, setCreating] = useState({});

  const LOAD_ERRORS = {
    already_linked: 'This document is already linked to a load.',
    no_extracted_data: 'Run extraction first. This document has no extracted data.',
    document_not_found: 'Document not found.',
  };

  // Server-side, single transaction: creates load + stops and links the document.
  async function createLoad(doc) {
    if (doc.load_id || creating[doc.id]) return;
    setCreating((m) => ({ ...m, [doc.id]: true }));
    setStatus(null);
    try {
      // Extracted appointment times are local wall time; interpret them in this browser's timezone. Emailed rate cons
      // use the company RPC (any office member; the load is the owner's; a teammate's earlier tap returns that load).
      // Uploads: the load goes to the active company (owner / Management / Dispatcher there), checked again by the RPC.
      const profileId = doc.source === 'email' ? null : uploadProfileFor((await fetchActiveCompany())?.active);
      const { data: loadId, error } = await createLoadFromDoc(supabase, doc, Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles', { profileId });
      if (error) {
        const code = Object.keys(LOAD_ERRORS).find((k) => (error.message || '').includes(k));
        console.error('create_load_from_document', error);
        if (code === 'already_linked') loadDocs();
        throw new Error(LOAD_ERRORS[code] || 'Could not create the load, please try again.');
      }
      // The RPC doesn't copy equipment yet; fill loads.equipment_type (user-updatable column). Best effort.
      const equip = (doc.ai_extracted_data?.equipment_type || '').trim();
      if (equip) {
        const { error: eqErr } = await supabase.from('loads').update({ equipment_type: equip }).eq('id', loadId).is('equipment_type', null);
        if (eqErr) console.error('[createLoad] equipment_type', eqErr);
      }
      // Same for the rate con weight → loads.weight (user-updatable column; no SQL needed). The Truck tab compares
      // scale tickets with it. Best effort: a failure here never blocks the new load.
      const wt = extractedWeightLb(doc.ai_extracted_data);
      if (wt) {
        const { error: wErr } = await supabase.from('loads').update({ weight: wt }).eq('id', loadId).is('weight', null);
        if (wErr) console.error('[createLoad] weight', wErr);
      }
      // Rate con trip miles → loads.total_miles (planned miles), only while it's empty; tagged miles_source='rate_con'
      // once the 20261018000300 migration has run (works without it too). Best effort, like weight.
      const mi = extractedMiles(doc.ai_extracted_data);
      if (mi) {
        const m = await fillLinkedLoadMiles(supabase, { loadId, userId: null, miles: mi });
        if (m.error) console.error('[createLoad] total_miles', m.error);
      }
      setDocs((list) => list.map((d) => (d.id === doc.id ? { ...d, load_id: loadId } : d)));
      notifyLoadChanged(loadId);
      router.refresh();
      router.push(`/loads/${loadId}`);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setCreating((m) => ({ ...m, [doc.id]: false }));
    }
  }

  const [status, setStatus] = useState(null);
  const [view_, setView] = useState('mine'); // 'mine' (default) | 'team'
  const [inboxOpen, setInboxOpen] = useState(true);
  const [waitingMore, setWaitingMore] = useState(false);
  const [vaultTick, setVaultTick] = useState(0);
  const [docs, setDocs] = useState([]);
  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const docsReqRef = useRef(0);
  const [refreshErr, setRefreshErr] = useState(null);
  const docsReadyRef = useRef(false);
  docsReadyRef.current = listState === 'ready';
  const [extracting, setExtracting] = useState({});
  const [extractErr, setExtractErr] = useState({});

  async function extract(id, force = false) {
    setExtracting((m) => ({ ...m, [id]: true }));
    setExtractErr((m) => ({ ...m, [id]: null }));
    try {
      const res = await authedFetch(supabase.auth, '/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: id, force }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Extraction failed, please try again.');
      if (body.reclassified === 'coi') {
        setDocs((list) => list.filter((d) => d.id !== id)); // PR #84: COIs live in Company → Company documents
        setStatus({ type: 'ok', text: 'This looks like a certificate of insurance, so it was saved as a COI in Company → Company documents. Open Company → Insurance to read it.' });
        return;
      }
      if (body.reclassified === 'bol' || body.reclassified === 'scale_ticket') {
        // PR #110: a BOL / scale ticket uploaded as a rate con is re-typed; its "Link to load" picker opens below.
        setDocs((list) => list.map((d) => (d.id === id ? { ...d, doc_type: body.reclassified, ai_extracted_data: body.data } : d)));
        setStatus({ type: 'ok', text: `This looks like a ${body.reclassified === 'bol' ? 'bill of lading' : 'scale ticket'}, so it was saved as one. Pick its load below.` });
        return;
      }
      setDocs((list) => list.map((d) => (d.id === id ? { ...d, ai_extracted_data: body.data } : d)));
      // A (re-)run can fill the linked load's miles/weight on the server: refresh any open load page (QA #82, RC-03).
      const linkedLoad = body.loadId || docs.find((d) => d.id === id)?.load_id;
      if (linkedLoad) notifyLoadChanged(linkedLoad);
      router.refresh();
    } catch (err) {
      setExtractErr((m) => ({ ...m, [id]: err.message }));
    } finally {
      setExtracting((m) => ({ ...m, [id]: false }));
    }
  }


  const [deleteErr, setDeleteErr] = useState({});
  async function removeDoc(doc) {
    setDeleteErr((m) => ({ ...m, [doc.id]: null }));
    const r = await deleteDocument(supabase, doc, BUCKET);
    if (!r.ok) { setDeleteErr((m) => ({ ...m, [doc.id]: r.error })); return false; }
    setDocs((list) => list.filter((x) => x.id !== doc.id));
    if (r.fileError) setStatus({ type: 'error', text: r.fileError });
    return true;
  }

  async function loadDocs() {
    const req = ++docsReqRef.current;
    if (!docsReadyRef.current) setListState('loading');
    if (!(await hasSession(supabase))) { if (req === docsReqRef.current) { if (docsReadyRef.current) setRefreshErr("Your session has expired or is still loading. Tap Retry, or sign in again."); setListState((st) => (st === 'ready' ? 'ready' : 'error')); } return; }
    const sinceIso = new Date(Date.now() - INBOX_RECENT_DAYS * 864e5).toISOString();
    const q = (cols) => supabase.from('documents').select(cols)
      .or('doc_type.is.null,doc_type.neq.receipt') // expense receipts live on /expenses
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(INBOX_RECENT_CAP + INBOX_WAITING_CAP);
    // Email-in columns (20261019000200); before that migration, fall back to the old column list.
    let { data, error } = await q(`${DOC_COLS}, ${EMAIL_COLS}`);
    if (error?.code === '42703') ({ data, error } = await q(DOC_COLS));
    if (req !== docsReqRef.current) return;
    if (error) {
      console.error('[documents] fetch', error);
      // Keep an already-shown list; otherwise show the error + Retry instead of an empty state.
      if (docsReadyRef.current) setRefreshErr("Couldn't refresh. Showing the last loaded documents.");
      return setListState((st) => (st === 'ready' ? 'ready' : 'error'));
    }
    const waiting = await fetchWaitingRateCons(supabase);
    if (req !== docsReqRef.current) return;
    setWaitingMore(waiting.length >= INBOX_WAITING_CAP);
    data = mergeInboxDocs((data || []).filter(isDocumentsTabDoc), waiting.filter(isDocumentsTabDoc));
    setRefreshErr(null);
    setDocs((data || []).filter(isDocumentsTabDoc)); // PR #84: W-9 / COI / MC Authority / NOA live on Company
    setListState('ready');
    loadSkipped();
  }

  // Attachments skipped from recent rate con emails (not a PDF, over 10 MB, …), last 7 days. Optional: errors hide it.
  const [skippedRows, setSkipped] = useState([]);
  const [dismissed, setDismissed] = useState([]);
  useEffect(() => { setDismissed(readDismissed(typeof window !== 'undefined' ? window.localStorage : null)); }, []);
  useEffect(() => { setInboxOpen(readInboxOpen(typeof window !== 'undefined' ? window.localStorage : null)); }, []);
  const skipped = visibleSkipped(skippedRows, dismissed);
  const dismissSkipped = (ids) => setDismissed(addDismissed(typeof window !== 'undefined' ? window.localStorage : null, ids));
  async function loadSkipped() {
    setSkipped(await fetchSkipped(supabase, skipScopeRef.current));
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    // INITIAL_SESSION fires once on subscribe, so no separate getSession() call is needed.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      // defer: avoid Supabase auth-lock deadlock. Fetch only with a session; re-fetch when it changes.
      if ((['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED'].includes(event) || (event === 'TOKEN_REFRESHED' && !docsReadyRef.current)) && u) setTimeout(() => loadDocs(), 0);
      if (event === 'SIGNED_OUT') { docsReqRef.current++; setDocs([]); setListState('loading'); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // An emailed rate con is read on the server: refresh every 10 s while any shows "Reading…".
  const reading = docs.some((d) => emailDraftState(d) === 'reading');
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => loadDocs(), 10_000);
    return () => clearInterval(t);
  }, [reading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUpload(e) {
    e.preventDefault();
    const form = e.target;
    if (await uploadRateCon(file)) form.reset();
  }

  // Upload + AI extraction for a rate con. Used by the Upload button and, directly, by "Scan rate con".
  // Returns true on success; failures set the page status.
  async function uploadRateCon(file) {
    if (!file || !user) return false;
    let contentType = resolveType(file);
    if (!ALLOWED_TYPES.includes(contentType)) {
      return setStatus({ type: 'error', text: `Unsupported file type (${contentType || file.type || 'unknown'}). Use PDF, JPEG, PNG, WebP or HEIC/HEIF.` });
    }
    if (file.size > MAX_BYTES) {
      return setStatus({ type: 'error', text: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.` });
    }
    setStatus(null);
    let uploadFile = file;
    if (isHeic(file, contentType)) {
      setConverting(true);
      try {
        uploadFile = await convertHeicToJpeg(file);
        contentType = 'image/jpeg';
      } catch (err) {
        return setStatus({ type: 'error', text: 'Could not convert this iPhone photo (HEIC) to JPEG. Try exporting it as JPEG, or take a screenshot and upload that.' });
      } finally {
        setConverting(false);
      }
      if (uploadFile.size > MAX_BYTES) {
        return setStatus({ type: 'error', text: `Converted photo is too large (${(uploadFile.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.` });
      }
    }
    setUploading(true);
    const safeName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${user.id}/${Date.now()}-${safeName}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, uploadFile, { contentType });
    if (upErr) {
      setUploading(false);
      return setStatus({ type: 'error', text: 'Upload failed: ' + upErr.message });
    }
    const docType = uploadType || 'rate_confirmation';
    const { data: inserted, error: dbErr } = await supabase.from('documents').insert({
      user_id: user.id,
      doc_type: docType,
      file_path: path,
      original_filename: uploadFile.name, // converted HEIC is saved as .jpg
      load_id: null,
      truck_id: null,
    }).select('id').single();
    setUploading(false);
    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([path]);
      return setStatus({ type: 'error', text: 'Saving record failed: ' + dbErr.message });
    }
    setStatus({ type: 'ok', text: 'Uploaded ' + file.name });
    setFile(null); setFileKey((k) => k + 1);
    await loadDocs();
    setVaultTick((n) => n + 1);
    if (inserted?.id && docType === 'rate_confirmation') extract(inserted.id);
    return true;
  }

  async function openScanner(files) {
    // Loads first, so the scanner opens with the suggested load already picked (its Load picker reads it once).
    // Loads for the "link to load" picker (newest first). Failure just leaves "No load".
    const { data, error } = await fetchVisibleLoads(supabase); // PR #110: drivers / members too
    if (error) console.error('[scan] loads', error);
    const rows = (data || []).map(loadForSuggest);
    // PR #110: preselect the scanner's Load with the user's active load (in transit / dispatched to them).
    setScanLoadId(suggestLoad(rows, { userId: user?.id })?.loadId || '');
    setScanLoads(rows.map((l) => ({ id: l.id, label: loadPickLabel(l) })));
    setScanFiles(files);
  }

  // Scanned rate con: the scanner's PDF goes through pickFile, exactly like a PDF from Files / PDF.
  // Uploads and extracts immediately (same as pressing Upload); on failure the PDF stays selected so Upload can retry.
  function applyRateConScan({ file: pdf }) {
    setScanFiles(null);
    pickFile(pdf);
    uploadRateCon(pdf);
    return null;
  }

  async function saveScan(scan) {
    if (scan.docType === 'ratecon') return applyRateConScan(scan);
    const err = await uploadScan(supabase, user?.id, scan);
    if (err && !err.saved) return err;
    setScanFiles(null);
    setStatus(err?.warning ? { type: 'error', text: err.warning } : { type: 'ok', text: `Saved ${scan.file.name}${scan.loadId ? ' to the load' : ''}.` });
    if (!err && scan.loadId) notifyLoadChanged(scan.loadId);
    await loadDocs();
    setVaultTick((n) => n + 1);
    return null;
  }

  async function view(doc) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
    if (error) return setStatus({ type: 'error', text: 'Could not open file: ' + error.message });
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  return (
    <main style={{ ...s.main, paddingBottom: 'calc(1rem + var(--fab-space))' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Document Upload</h1>
      <p style={{ margin: '0.15rem 0 0.6rem' }}><Link href="/documents/checklist" style={s.tap}>Setup checklist</Link></p>

      {supabaseConfigError ? (
        <p style={s.error}>{supabaseConfigError}</p>
      ) : checking ? (
        <p style={s.muted}>Checking sign-in…</p>
      ) : !user ? (
        <div style={s.card}>
          <p style={s.error}>You need to be signed in to upload and view documents.</p>
          <SignInLink style={{ ...s.btn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>Sign in</SignInLink>
        </div>
      ) : (
        <>
          <form onSubmit={handleUpload} style={s.card}>
            <fieldset style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }} disabled={uploading || converting}>
              <legend style={{ display: 'block', padding: 0, marginBottom: '0.5rem', fontWeight: 600 }}>Upload Rate Confirmations, POD, BOL and other documents</legend>
              <label htmlFor="upload-type" style={{ display: 'block', fontSize: 14, fontWeight: 600, margin: '0 0 0.3rem' }}>Document type</label>
              <select id="upload-type" value={uploadType} onChange={(e) => setUploadType(e.target.value)}
                style={{ width: '100%', minHeight: 44, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', padding: '0 0.6rem', marginBottom: '0.5rem', background: 'var(--surface)' }}>
                {UPLOAD_TYPES.filter((t) => !isDriver || t.id !== 'rate_confirmation').map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <UploadMenu key={`menu-${fileKey}`} onFile={pickFile} onScan={openScanner} disabled={uploading || converting} />
              <div aria-live="polite" aria-atomic="true">
                {file && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                      <span style={{ position: 'absolute', width: 1, height: 1, margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Selected file: </span>{file.name}
                    </span>
                    <button type="button" onClick={() => { setFile(null); setFileKey((k) => k + 1); }} aria-label="Remove selected file"
                      style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>✕</button>
                  </div>
                )}
              </div>
            </fieldset>
            <div style={{ position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', zIndex: 10, background: 'var(--surface)', padding: '0.6rem 0 0.4rem', marginTop: '0.25rem' }}>
            <button type="submit" disabled={!file || uploading || converting} style={{ ...s.btn, marginTop: 0, opacity: !file || uploading || converting ? 0.6 : 1 }}>
              {converting ? 'Converting photo…' : uploading ? 'Uploading…' : 'Upload'}
            </button>
            </div>
          </form>

          {status && <p style={status.type === 'ok' ? s.ok : s.error}>{status.text}</p>}

          {!isDriver && <RateconEmailCard supabase={supabase} userId={user.id} />}

          <div style={s.card}>
            <button type="button" data-testid="docs-inbox-toggle" aria-expanded={inboxOpen} aria-controls="docs-inbox" onClick={() => { const next = !inboxOpen; setInboxOpen(next); writeInboxOpen(typeof window !== 'undefined' ? window.localStorage : null, next); }}
              style={{ display: 'flex', width: '100%', minHeight: 44, alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'none', border: 'none', padding: 0, color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
              <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Needs attention</h2>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{inboxOpen ? 'Hide' : 'Show'}</span>
            </button>
            {!inboxOpen && <p style={{ ...s.muted, margin: '0.35rem 0 0' }}>{docs.filter(isEmailDraft).length ? `${docs.filter(isEmailDraft).length} waiting for review` : 'Recent uploads from the last 7 days'}</p>}
            {inboxOpen && <div id="docs-inbox">
            <div role="tablist" aria-label="Whose documents" data-testid="docs-view-toggle" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--surface-2)', margin: '0.75rem 0' }}>
              {[['mine', 'Mine'], ['team', 'Team']].map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={view_ === id} data-testid={`docs-view-${id}`} onClick={() => setView(id)}
                  style={{ flex: 1, minHeight: 44, borderRadius: 8, border: 'none', fontSize: 15, fontWeight: 600, cursor: 'pointer',
                    background: view_ === id ? 'var(--surface)' : 'transparent', color: view_ === id ? 'var(--text)' : 'var(--text-muted)',
                    outline: view_ === id ? '1px solid var(--border)' : 'none' }}>{label}</button>
              ))}
            </div>
            {view_ === 'team' ? (
              <>
                <p style={{ ...s.muted, marginTop: '-0.25rem' }}>Recent load paperwork from your team, last 7 days, on the loads you can open.</p>
                <TeamDocsList supabase={supabase} inbox onDeleted={(id) => setDocs((list) => list.filter((x) => x.id !== id))} />
              </>
            ) : (<>
            {docs.some(isEmailDraft) && <p data-testid="email-drafts-count" style={{ ...s.muted, marginTop: '-0.25rem' }}>{(() => { const n = docs.filter(isEmailDraft).length; return n === 1 ? '1 rate con from email is waiting for review.' : `${n} rate cons from email are waiting for review.`; })()}</p>}
            {waitingMore && <p data-testid="waiting-more" style={s.muted}>More rate cons are waiting in Load documents.</p>}
            {!isDriver && skipped.map((m) => (
              <div key={m.id} data-testid="email-skipped" data-above-fab style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 8, padding: '0.5rem 0.4rem 0.5rem 0.7rem', fontSize: '0.85rem', margin: '0.5rem 0' }}>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', paddingTop: 10 }}>{skippedLine(m)}</span>
                <button type="button" data-testid="email-skipped-dismiss" onClick={() => dismissSkipped([m.id])} aria-label={`Dismiss: ${skippedLine(m)}`}
                  style={{ flex: 'none', minWidth: 44, minHeight: 44, border: 'none', background: 'none', color: 'var(--warning)', fontSize: 20, lineHeight: 1, cursor: 'pointer' }}>×</button>
              </div>
            ))}
            {refreshErr && listState === 'ready' && <LoadError subtle message={refreshErr} onRetry={() => { setRefreshErr(null); loadDocs(); }} />}
            {listState === 'error' ? <LoadError message="Couldn't load your documents." onRetry={loadDocs} />
              : listState === 'loading' ? <Loading label="Loading documents…" />
              : docs.length === 0 ? <p style={s.muted}>Nothing from the last 7 days. Older paperwork is in Load documents.</p> : docs.map((d) => (
              <div key={d.id} data-confirm-row style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--divider)' }}>
                <div style={{ ...s.item, padding: 0, borderBottom: 'none' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename}</div>
                    <div style={s.muted}>
                      {d.source === 'email' && <span data-testid="from-email-badge" style={s.badge}>From email</span>}
                      {isNotRatecon(d) ? <span data-testid="not-ratecon-label">Not a rate con · needs manual entry</span> : docTypeLabel(d.doc_type)} · {new Date(d.created_at).toLocaleDateString()}
                    </div>
                    {teammateEmailDoc(d, user?.id) && <div data-testid="team-email-note" style={{ ...s.muted, fontSize: '0.8rem' }}>Emailed to a teammate’s rate con address</div>}
                    {canChangeType && !teammateEmailDoc(d, user?.id) && (
                      <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 13, color: 'var(--text)', marginTop: 4 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>Change type</span>
                        <select data-testid="change-type" aria-label={`Change type for ${d.original_filename || 'document'}`} value={CHANGE_TYPES.some((t) => t.id === d.doc_type) ? d.doc_type : ''} disabled={!!typeBusy[d.id]}
                          onChange={(e) => changeType(d, e.target.value)} style={{ minHeight: 44, fontSize: 15, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', maxWidth: '100%', minWidth: 0 }}>
                          {!CHANGE_TYPES.some((t) => t.id === d.doc_type) && <option value="" disabled>{docTypeLabel(d.doc_type)}</option>}
                          {CHANGE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.short || t.label}</option>)}
                        </select>
                      </label>
                    )}
                    {canChangeType && typeErr[d.id] && (
                      <div role="alert" data-testid="change-type-error" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4, fontSize: 13, color: 'var(--danger)' }}>
                        <span>{typeErr[d.id].error}</span>
                        <button type="button" data-testid="change-type-retry" disabled={!!typeBusy[d.id]} onClick={() => changeType(d, typeErr[d.id].docType)}
                          style={{ minHeight: 36, padding: '0 12px', borderRadius: 8, border: '1px solid var(--danger)', background: 'var(--surface)', color: 'var(--danger)', fontWeight: 600 }}>Retry</button>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => view(d)} style={{ ...s.btn, width: 'auto', marginTop: 0, minHeight: 44, padding: '0.5rem 0.9rem' }}>View</button>
                    {!teammateEmailDoc(d, user?.id) && <ConfirmButton prompt={deletePrompt(d)} ariaLabel={`${deletePrompt(d)} ${d.original_filename || ''}`.trim()} onConfirm={() => removeDoc(d)} />}
                  </div>
                </div>
                {deleteErr[d.id] && <p role="alert" style={{ ...s.error, fontSize: '0.85rem' }}>{deleteErr[d.id]}</p>}
                {isLoadDocType(d.doc_type) ? (
                  <DocLoadLink supabase={supabase} doc={d} onLinked={(loadId) => { setDocs((list) => list.map((x) => (x.id === d.id ? { ...x, load_id: loadId } : x))); if (loadId) notifyLoadChanged(loadId); setStatus({ type: 'ok', text: loadId ? `Linked ${d.original_filename} to the load.` : `Unlinked ${d.original_filename}.` }); }} />
                ) : !EXTRACTABLE(d.doc_type) ? (
                  d.load_id ? <Link href={`/loads/${d.load_id}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: 'var(--primary)' }}>View load</Link> : null
                ) : extracting[d.id] ? (
                  <p style={s.muted}>Extracting…</p>
                ) : emailDraftState(d) === 'reading' ? (
                  <p style={s.muted} data-testid="email-reading">Reading the rate con from your email…</p>
                ) : (
                  <>
                    {d.ai_extracted_data && <Summary x={d.ai_extracted_data} />}
                    {emailDraftState(d) === 'ready' && <p data-testid="email-review" style={{ ...s.muted, margin: '0.25rem 0' }}>Draft from email. Check these details against the PDF (View), then tap Create load.</p>}
                    {emailDraftState(d) === 'manual' && (
                      <div data-testid="email-manual" style={{ background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 8, padding: '0.5rem 0.7rem', fontSize: '0.85rem', margin: '0.25rem 0' }}>
                        <strong>Needs manual entry.</strong> {emailReadProblem(d.extraction_error)}{' '}
                        <Link href="/loads/new" style={{ color: 'var(--primary)', fontWeight: 600 }}>Enter load by hand</Link>
                      </div>
                    )}
                    {extractErr[d.id] && <p style={{ ...s.error, fontSize: '0.85rem' }}>{extractErr[d.id]}</p>}
                    <button onClick={() => (d.ai_extracted_data ? window.confirm('Re-run extraction? This overwrites the current data.') && extract(d.id, true) : extract(d.id))} style={{ background: 'none', border: 'none', color: 'var(--primary)', padding: '0.4rem 0', fontSize: '0.9rem' }}>
                      {d.ai_extracted_data ? 'Re-run extraction' : typeChanged[d.id] ? 'Read as rate con' : 'Run extraction'}
                    </button>
                    {d.load_id ? (
                      <Link href={`/loads/${d.load_id}`} style={{ ...s.btn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box', background: 'var(--success-solid)', color: 'var(--on-success)', marginTop: '0.25rem' }}>View load</Link>
                    ) : d.ai_extracted_data ? (
                      <button onClick={() => createLoad(d)} disabled={!!creating[d.id]} style={{ ...s.btn, marginTop: '0.25rem', background: 'var(--success-solid)', color: 'var(--on-success)', opacity: creating[d.id] ? 0.6 : 1 }}>
                        {creating[d.id] ? 'Creating load…' : 'Create load'}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ))}
            </>)}
            </div>}
          </div>
          <p data-testid="vault-note" style={{ ...s.muted, marginTop: 0 }}>Load paperwork lives in the vaults below. W-9, COI, MC Authority and NOA are in <a href="/company#company-documents" style={{ ...s.tap, color: 'var(--primary)' }}>Company → Company documents</a>.</p>
          <VaultTiles supabase={supabase} refreshKey={vaultTick} />
        </>
      )}
      {scanFiles && <Scanner allowRateCon={!isDriver} typeIds={DOCUMENTS_SCAN_TYPE_IDS} initialFiles={scanFiles} loads={scanLoads} initialLoadId={scanLoadId} onClose={() => setScanFiles(null)} onSave={saveScan} />}
    </main>
  );
}

function fmtStop(st) {
  if (!st) return null;
  const when = [st.date, st.time].filter(Boolean).join(' ');
  return [when, st.address].filter(Boolean).join(' — ') || null;
}

function fmtParty(p) {
  if (!p) return null;
  return [p.name, p.address].filter(Boolean).join(', ') || null;
}

function Summary({ x }) {
  const rows = [
    ['Broker', x.broker_name],
    ['Load #', x.load_number],
    ['Refs', x.reference_numbers?.length ? x.reference_numbers.join(', ') : null],
    ['Rate', typeof x.rate === 'number' ? fmtMoney(x.rate) : null],
    ['Equipment', x.equipment_type],
    ['Weight', extractedWeightLb(x) ? `${extractedWeightLb(x).toLocaleString('en-US')} lb` : null],
    ['Miles', extractedMiles(x) ? `${extractedMiles(x).toLocaleString('en-US')} mi` : null],
    ['Shipper', fmtParty(x.shipper)],
    ['Pickup', fmtStop(x.pickup)],
    ['Receiver', fmtParty(x.receiver)],
    ['Delivery', fmtStop(x.delivery)],
    ['Notes', x.notes],
  ].filter(([, v]) => v);
  if (!rows.length) return <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No fields extracted.</p>;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', margin: '0.5rem 0 0', fontSize: '0.85rem', background: 'var(--surface-2)', borderRadius: 8, padding: '0.6rem' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-word' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
