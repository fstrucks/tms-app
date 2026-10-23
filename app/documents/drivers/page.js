'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../lib/authedFetch';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import SignInLink from '../../components/SignInLink';
import { Loading, LoadError } from '../../components/DataState';

const main = { padding: '1rem', fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto', paddingBottom: 'calc(1rem + var(--fab-space))' };
const field = { width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', padding: '0 0.6rem', background: 'var(--surface)', color: 'var(--text)' };
const muted = { color: 'var(--text-muted)', fontSize: '0.85rem' };
const btn = { minHeight: 44, padding: '0 0.9rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', display: 'inline-flex', alignItems: 'center', textDecoration: 'none' };

function mdy(day) {
  const [y, m, d] = String(day || '').split('-');
  return y && m && d ? `${m}/${d}/${y}` : '';
}

function FileRow({ file }) {
  return (
    <div data-testid="driver-vault-file" style={{ padding: '0.65rem 0', borderTop: '1px solid var(--divider)' }}>
      <div style={{ overflowWrap: 'anywhere' }}>{file.original_filename || file.label}</div>
      <div style={muted}>{file.label}{file.created_at ? ` · ${new Date(file.created_at).toLocaleDateString()}` : ''}</div>
      {file.url && <a href={file.url} target="_blank" rel="noopener noreferrer" style={{ ...btn, marginTop: 8 }}>View</a>}
    </div>
  );
}

export default function DriverVaultPage() {
  const supabase = getSupabase();
  const [state, setState] = useState('loading');
  const [signedOut, setSignedOut] = useState(false);
  const [body, setBody] = useState(null);
  const [q, setQ] = useState('');

  async function load() {
    setState('loading');
    try {
      const res = await authedFetch(supabase.auth, '/api/documents/drivers', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) { setSignedOut(true); setState('ready'); return; }
      if (!res.ok) return setState('error');
      setBody(json);
      setState('ready');
    } catch {
      setState('error');
    }
  }

  useEffect(() => { if (supabase) load(); else setState('ready'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const drivers = (body?.drivers || []).filter((d) => !needle || String(d.name || '').toLowerCase().includes(needle));
  const driverRole = body?.role === 'driver';

  return (
    <main style={main}>
      <p style={{ margin: '0 0 0.35rem' }}><Link href="/documents">Documents</Link></p>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.35rem' }}>Driver documents</h1>
      <p style={{ ...muted, marginTop: 0 }}>{driverRole ? 'Your CDL, medical card, MVR, and drug tests.' : 'CDL, medical card, MVR, drug test, and other driver files, grouped by driver.'}</p>
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p> : signedOut ? (
        <div style={{ border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem' }}>
          <p style={{ color: 'var(--danger)' }}>You need to be signed in to view documents.</p>
          <SignInLink style={{ ...btn, width: '100%', justifyContent: 'center', boxSizing: 'border-box' }}>Sign in</SignInLink>
        </div>
      ) : state === 'error' ? <LoadError message="Couldn't load driver files." onRetry={load} /> : state === 'loading' ? <Loading label="Loading driver files…" /> : (
        <>
          {body?.unavailable && <p style={muted}>Driver files aren’t available yet.</p>}
          {body?.capped && <p style={muted}>Showing the newest 300 files.</p>}
          {!driverRole && (
            <label style={{ display: 'block', margin: '0 0 0.75rem' }}>
              <span style={{ ...labelStyle() }}>Find a driver</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} style={field} autoComplete="off" />
            </label>
          )}
          {drivers.length === 0 && !body?.unassigned?.length ? <p style={muted}>{driverRole ? 'No driver profile is linked to this sign-in.' : 'No drivers match.'}</p> : null}
          {drivers.map((d) => {
            const exp = [d.cdlExpiry ? `CDL expires ${mdy(d.cdlExpiry)}` : null, d.medCardExpiry ? `Medical card expires ${mdy(d.medCardExpiry)}` : null].filter(Boolean).join(' · ');
            return (
              <section key={d.id} data-testid="driver-vault-group" style={{ border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' }}>
                <h2 style={{ fontSize: '1.05rem', margin: 0, overflowWrap: 'anywhere' }}>{d.name}{d.active ? '' : ' · Inactive'}</h2>
                {exp && <p style={{ ...muted, margin: '0.2rem 0 0' }}>{exp}</p>}
                {d.files?.length ? d.files.map((f) => <FileRow key={f.id} file={f} />) : <p style={{ ...muted, marginBottom: 0 }}>Nothing on file yet.</p>}
              </section>
            );
          })}
          {!driverRole && body?.unassigned?.length > 0 && (
            <section data-testid="driver-vault-unassigned" style={{ border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' }}>
              <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Not linked to a driver</h2>
              {body.unassigned.map((f) => <FileRow key={f.id} file={f} />)}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function labelStyle() {
  return { display: 'block', fontSize: 14, fontWeight: 600, margin: '0 0 0.25rem' };
}
