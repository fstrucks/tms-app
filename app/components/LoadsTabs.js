'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TABS, DEFAULT_TAB, parseTab, countByTab, groupLoads, groupLabel, currentInTransit, pickupStop, deliveryStop } from '../lib/loadTabs';
import { stopSummary } from '../lib/loads';

// Segmented Active / Pending / Booked / Past control + date-grouped list.
// The tab lives in ?tab= (replaceState, so Back leaves the page rather than stepping through tabs).
// renderLoad(load) draws one row; the page owns the card markup (and the status tag, so #40's StatusTag swaps in there).
const blue = '#1d4ed8';
const st = {
  seg: { display: 'flex', gap: 2, padding: 3, background: '#f3f4f6', borderRadius: 10, margin: '0 0 0.9rem', width: '100%', boxSizing: 'border-box' },
  btn: { flex: '1 1 0', minWidth: 0, minHeight: 44, border: 'none', borderRadius: 8, background: 'transparent', color: '#374151', fontSize: '0.9rem', fontFamily: 'inherit', padding: '0 0.25rem', cursor: 'pointer', touchAction: 'manipulation', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  on: { background: '#fff', color: blue, fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,0.12)' },
  count: { marginLeft: 4, fontSize: '0.78rem', color: '#6b7280', fontWeight: 500 },
  head: { fontSize: '0.8rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0.9rem 0 0.4rem' },
  bar: { display: 'block', border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1e3a8a', borderRadius: 12, padding: '0.6rem 0.85rem', marginBottom: '0.9rem', textDecoration: 'none', fontSize: '0.9rem' },
  muted: { color: '#6b7280', fontSize: '0.9rem' },
};

export default function LoadsTabs({ loads, renderLoad }) {
  const [tab, setTab] = useState(DEFAULT_TAB);
  useEffect(() => { setTab(parseTab(new URLSearchParams(window.location.search).get('tab'))); }, []);

  const pick = (id) => {
    setTab(id);
    const u = new URL(window.location.href);
    if (id === DEFAULT_TAB) u.searchParams.delete('tab'); else u.searchParams.set('tab', id);
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
  };

  const counts = countByTab(loads);
  const groups = groupLoads(loads, tab);
  const onRoad = tab === 'active' ? currentInTransit(loads) : null;

  return (
    <>
      <div role="tablist" aria-label="Load status" style={st.seg}>
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <button key={t.id} type="button" role="tab" id={`loads-tab-${t.id}`} aria-selected={on} aria-controls="loads-tabpanel"
              onClick={() => pick(t.id)} style={{ ...st.btn, ...(on ? st.on : null) }}>
              {t.label}<span style={{ ...st.count, ...(on ? { color: blue } : null) }}>{counts[t.id]}</span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id="loads-tabpanel" aria-labelledby={`loads-tab-${tab}`}>
        {onRoad && (
          <Link href={`/loads/${onRoad.id}`} style={st.bar}>
            <strong>On the road</strong> · {stopSummary(pickupStop(onRoad))} → {stopSummary(deliveryStop(onRoad))}
          </Link>
        )}
        {groups.length === 0 && <p style={st.muted}>No {TABS.find((t) => t.id === tab).label.toLowerCase()} loads.</p>}
        {groups.map((g) => (
          <section key={g.key || 'none'} aria-label={groupLabel(g.key)}>
            <h2 style={st.head}>{groupLabel(g.key)}</h2>
            {g.loads.map(renderLoad)}
          </section>
        ))}
      </div>
    </>
  );
}
