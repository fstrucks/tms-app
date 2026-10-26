'use client';
// Documents tab → "Team" view: load documents from everyone in the company that this user may see (PR #110 rules,
// enforced by /api/documents/team). Each row shows who uploaded it and its load. Delete only on your own uploads.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchTeamDocs } from '../lib/loadDocsClient';
import { formatLocalDate } from '../lib/localDate';
import { deleteDocument, deletePrompt } from '../lib/documents';
import { Loading, LoadError } from './DataState';
import ConfirmButton from './ui/ConfirmButton';

const muted = { color: 'var(--text-muted)', fontSize: '0.85rem' };
const btn = { minHeight: 44, padding: '0.5rem 0.9rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' };

export default function TeamDocsList({ supabase, onDeleted, onCount, inbox = false }) {
  const [state, setState] = useState('loading');
  const [docs, setDocs] = useState([]);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState({});
  async function load() {
    setState('loading');
    const r = await fetchTeamDocs(supabase, { inbox });
    if (r.error) { console.error('[documents] team', r.error.status || ''); return setState('error'); }
    const next = r.data || [];
    setDocs(next); setMore(!!r.more); setState('ready');
    onCount?.(next.length);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(d) {
    setErr((m) => ({ ...m, [d.id]: null }));
    const r = await deleteDocument(supabase, d, 'documents');
    if (!r.ok) { setErr((m) => ({ ...m, [d.id]: r.error })); return false; }
    const next = docs.filter((x) => x.id !== d.id);
    setDocs(next);
    onCount?.(next.length);
    onDeleted?.(d.id);
    return true;
  }
  async function view(d) {
    if (d.url) return window.open(d.url, '_blank', 'noopener');
    load(); // signed link expired: refresh the list
  }

  if (state === 'error') return <LoadError message="Couldn't load team documents." onRetry={load} />;
  if (state === 'loading') return <Loading label="Loading team documents…" />;
  if (!docs.length) return <p style={muted} data-testid="team-docs-empty">{inbox ? 'Nothing from your team needs attention.' : 'No team documents yet. BOLs, PODs and scale tickets linked to a load show here.'}</p>;
  return (
    <div data-testid="team-docs">
      {inbox && more && <p style={muted}>More documents need attention than fit here. Filed copies stay in the vaults.</p>}
      {docs.map((d) => (
        <div key={d.id} data-confirm-row data-testid="team-doc" style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--divider)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 180px' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{d.original_filename || d.label}</div>
              <div style={{ ...muted, overflowWrap: 'anywhere' }}>{d.label} · {formatLocalDate(d.created_at)}</div>
              <div style={{ ...muted, overflowWrap: 'anywhere' }}>
                <span data-testid="team-doc-uploader">Uploaded by {d.uploader}</span>
                {d.load_id && <> · <Link href={`/loads/${d.load_id}`} style={{ color: 'var(--primary)' }} data-testid="team-doc-load">{d.load_label}</Link></>}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => view(d)} style={btn}>View</button>
              {d.own && d.file_path && <ConfirmButton prompt={deletePrompt(d)} ariaLabel={`${deletePrompt(d)} ${d.original_filename || ''}`.trim()} onConfirm={() => remove(d)} />}
            </div>
          </div>
          {err[d.id] && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{err[d.id]}</p>}
        </div>
      ))}
    </div>
  );
}
