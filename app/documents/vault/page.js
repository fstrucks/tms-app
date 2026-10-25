'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../lib/authedFetch';
import { docTypeLabel } from '../../lib/docTypes';
import { DATE_RANGE_ERROR, LOAD_VAULT_TYPES, reversedDateRange } from '../../lib/loadVault';
import { canDeleteHandledEmailRatecon, deleteHandledEmailRatecon, deletePrompt } from '../../lib/documents';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import SignInLink from '../../components/SignInLink';
import { Loading, LoadError } from '../../components/DataState';
import ConfirmButton from '../../components/ui/ConfirmButton';

const main = { padding: '1rem', fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto', paddingBottom: 'calc(1rem + var(--fab-space))' };
const field = { width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', padding: '0 0.6rem', background: 'var(--surface)', color: 'var(--text)' };
const label = { display: 'block', fontSize: 14, fontWeight: 600, margin: '0 0 0.25rem' };
const muted = { color: 'var(--text-muted)', fontSize: '0.85rem' };
const btn = { width: '100%', minHeight: 44, padding: '0.7rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' };
const tap = { display: 'inline-flex', alignItems: 'center', minHeight: 44 };
const TYPES = [['', 'All types'], ...LOAD_VAULT_TYPES.map((id) => [id, docTypeLabel(id)]), ['other', 'Other']];

function queryString(filters, cursor) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  if (cursor) p.set('cursor', cursor);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export default function LoadVaultPage() {
  const supabase = getSupabase();
  const [filters, setFilters] = useState({ load: '', broker: '', type: '', from: '', to: '' });
  const [draft, setDraft] = useState(filters);
  const [docs, setDocs] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [state, setState] = useState('loading');
  const [signedOut, setSignedOut] = useState(false);
  const [dateError, setDateError] = useState('');
  const [userId, setUserId] = useState(null);
  const [deleteErr, setDeleteErr] = useState({});
  const [fileNote, setFileNote] = useState('');
  const reqRef = useRef(0);

  async function removeDoc(d) {
    setDeleteErr((m) => ({ ...m, [d.id]: null }));
    setFileNote('');
    const r = await deleteHandledEmailRatecon(supabase, d, userId);
    if (!r.ok) { setDeleteErr((m) => ({ ...m, [d.id]: r.error })); return false; }
    setDocs((list) => list.filter((x) => x.id !== d.id));
    if (r.fileError) setFileNote(r.fileError);
    return true;
  }

  async function load(nextFilters, nextCursor, append) {
    const req = ++reqRef.current;
    setState(append ? 'more' : 'loading');
    try {
      const res = await authedFetch(supabase.auth, `/api/documents/vault${queryString(nextFilters, nextCursor)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (req !== reqRef.current) return;
      if (res.status === 401) { setSignedOut(true); setState('ready'); return; }
      if (!res.ok) { setState('error'); return; }
      setSignedOut(false);
      if (body.dateError) {
        setDateError(body.dateError);
        setDocs([]);
        setCursor(null);
        setState('ready');
        return;
      }
      setDateError('');
      setDocs((list) => (append ? [...list, ...(body.documents || [])] : (body.documents || [])));
      setCursor(body.nextCursor || null);
      setState('ready');
    } catch {
      if (req === reqRef.current) setState('error');
    }
  }

  function search(e) {
    e?.preventDefault();
    const next = { ...draft };
    setFilters(next);
    if (reversedDateRange(next)) {
      reqRef.current += 1;
      setDateError(DATE_RANGE_ERROR);
      setDocs([]);
      setCursor(null);
      setState('ready');
      return;
    }
    setDateError('');
    load(next, null, false);
  }

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    supabase.auth.getSession().then(({ data }) => { if (live) setUserId(data?.session?.user?.id || null); }).catch(() => {});
    load(filters, null, false);
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main style={main}>
      <p style={{ margin: '0 0 0.35rem' }}><Link href="/documents" style={tap}>Documents</Link></p>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.35rem' }}>Load documents</h1>
      <p style={{ ...muted, marginTop: 0 }}>Rate confirmations, BOLs, PODs, lumper receipts, and other load paperwork, including past loads.</p>
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p> : signedOut ? (
        <div style={{ border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem' }}>
          <p style={{ color: 'var(--danger)' }}>You need to be signed in to view documents.</p>
          <SignInLink style={{ ...btn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>Sign in</SignInLink>
        </div>
      ) : (
        <>
          <form data-testid="load-vault-filters" onSubmit={search} style={{ display: 'grid', gap: 8, marginBottom: '1rem' }}>
            <div>
              <label htmlFor="vault-load" style={label}>Load #</label>
              <input id="vault-load" value={draft.load} onChange={(e) => setDraft({ ...draft, load: e.target.value })} style={field} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="vault-broker" style={label}>Broker</label>
              <input id="vault-broker" value={draft.broker} onChange={(e) => setDraft({ ...draft, broker: e.target.value })} style={field} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="vault-type" style={label}>Document type</label>
              <select id="vault-type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} style={field}>
                {TYPES.map(([id, name]) => <option key={id || 'all'} value={id}>{name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="vault-from" style={label}>From</label>
              <input id="vault-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} style={field} />
            </div>
            <div>
              <label htmlFor="vault-to" style={label}>To</label>
              <input id="vault-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} style={field} />
            </div>
            {dateError ? <p role="alert" data-testid="vault-date-error" style={{ color: 'var(--danger)', margin: 0 }}>{dateError}</p> : null}
            <button type="submit" style={btn}>Search</button>
          </form>
          {state === 'error' ? <LoadError message="Couldn't load these documents." onRetry={() => load(filters, null, false)} /> : null}
          {state === 'loading' ? <Loading label="Loading documents…" /> : null}
          {state !== 'loading' && state !== 'error' && !dateError && docs.length === 0 ? <p style={muted}>No documents match.</p> : null}
          {fileNote ? <p role="alert" style={{ color: 'var(--danger)' }}>{fileNote}</p> : null}
          <div data-testid="load-vault-list">
            {docs.map((d) => (
              <div key={d.id} data-confirm-row data-testid="load-vault-row" style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--divider)' }}>
                <div style={{ overflowWrap: 'anywhere' }}>{d.original_filename || d.label}</div>
                <div style={muted}>{d.label} · {d.created_at ? new Date(d.created_at).toLocaleDateString() : ''}</div>
                {(d.broker || d.load_number) && <div style={{ ...muted, overflowWrap: 'anywhere' }}>{[d.load_number ? `#${d.load_number}` : null, d.broker].filter(Boolean).join(' · ')}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ ...btn, width: 'auto', display: 'inline-flex', alignItems: 'center', textDecoration: 'none', padding: '0 0.9rem' }}>View</a>}
                  {d.load_id && <Link href={`/loads/${d.load_id}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: 'var(--primary)' }}>{d.load_label || 'Open load'}</Link>}
                  {canDeleteHandledEmailRatecon(d, userId) && (
                    <span data-testid="handled-ratecon-delete">
                      <ConfirmButton prompt={deletePrompt(d)} ariaLabel={`${deletePrompt(d)} ${d.original_filename || ''}`.trim()} onConfirm={() => removeDoc(d)} />
                    </span>
                  )}
                </div>
                {deleteErr[d.id] && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{deleteErr[d.id]}</p>}
              </div>
            ))}
          </div>
          {cursor && state !== 'error' && (
            <button type="button" data-testid="load-more" disabled={state === 'more'} onClick={() => load(filters, cursor, true)} style={{ ...btn, marginTop: '0.75rem', opacity: state === 'more' ? 0.6 : 1 }}>
              {state === 'more' ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </main>
  );
}
