'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../lib/authedFetch';
import { companyAttentionCount, companyAttentionLabel } from '../lib/companyDocs';
import { MAINTENANCE_VAULT_ENABLED, fetchMaintenanceCount, maintenanceVaultHref } from '../lib/maintenanceVault';

const tile = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
  minHeight: 104, padding: '12px 8px', borderRadius: 12, border: '1px solid var(--divider)',
  background: 'var(--surface)', color: 'var(--text)', textDecoration: 'none', textAlign: 'center',
};
const countStyle = { fontSize: '1.35rem', fontWeight: 700, lineHeight: 1.1 };
const labelStyle = { fontSize: 14, lineHeight: 1.25, overflowWrap: 'anywhere' };

function Count({ n, capped }) {
  if (typeof n !== 'number') return <span style={{ ...countStyle, color: 'var(--text-muted)' }}>—</span>;
  return <span style={countStyle}>{capped ? `${n}+` : n}</span>;
}

export default function VaultTiles({ supabase, refreshKey = 0 }) {
  const [counts, setCounts] = useState(null);
  const [attention, setAttention] = useState(0);
  const [maint, setMaint] = useState(null);
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res = await authedFetch(supabase.auth, '/api/documents/vault-counts', { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!stop && res.ok) setCounts(body);
        const docs = await authedFetch(supabase.auth, '/api/company/documents', { cache: 'no-store' });
        const vault = await docs.json().catch(() => ({}));
        if (!stop && docs.ok) setAttention(companyAttentionCount(vault.vault));
      } catch { /* tiles still open */ }
      // Hidden until Alex's maintenance vault ships. Do not call the RPC while the flag is off.
      if (MAINTENANCE_VAULT_ENABLED) {
        const m = await fetchMaintenanceCount(supabase);
        if (!stop) setMaint(m.count);
      }
    })();
    return () => { stop = true; };
  }, [supabase, refreshKey]);

  const items = [
    { href: '/documents/vault', testid: 'vault-tile-loads', icon: '📄', label: 'Load documents', n: counts?.loadDocs, text: 'Rate cons, BOLs, PODs, and the rest of the load paperwork' },
    { href: '/documents/drivers', testid: 'vault-tile-drivers', icon: '🪪', label: 'Driver documents', n: counts?.driverDocs, capped: counts?.driverDocsCapped, text: 'CDL, medical card, MVR, and drug tests' },
    { href: '/company#company-documents', testid: 'vault-tile-company', icon: '🏢', label: 'Company documents', n: counts?.companyDocs, text: 'W-9, COI, MC Authority, and NOA' },
  ];
  if (MAINTENANCE_VAULT_ENABLED) {
    items.splice(2, 0, {
      href: maintenanceVaultHref(), testid: 'vault-tile-maintenance', icon: '🔧', label: 'Maintenance', n: maint,
      text: 'Truck maintenance records',
    });
  }

  return (
    <div data-testid="vault-tiles" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '0 0 1rem' }}>
      {items.map((it) => (
        <Link key={it.testid} href={it.href} data-testid={it.testid} aria-label={typeof it.n === 'number' ? `${it.label}, ${it.n}` : it.label} style={tile}>
          <span aria-hidden="true" style={{ fontSize: 26, lineHeight: 1 }}>{it.icon}</span>
          <Count n={it.n} capped={it.capped} />
          <span style={labelStyle}>{it.label}</span>
          {it.testid === 'vault-tile-company' && attention > 0 && <span data-testid="company-attention" style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)', lineHeight: 1.2 }}>{companyAttentionLabel(attention)}</span>}
        </Link>
      ))}
    </div>
  );
}
