'use client';
// Home card: services that are overdue or due soon across the trucks you can see. Hidden when nothing is due
// or before the schedules database update is applied. Data: /api/truck/schedules?due=1.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { STATUS_LABEL, dueText, badgeStyle } from '../lib/pmSchedule';

const card = { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.9rem', background: 'var(--surface)', marginTop: '0.75rem' };

export default function HomeMaintenanceDue({ supabase, user }) {
  const [due, setDue] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const t = (await supabase.auth.getSession())?.data?.session?.access_token;
      try {
        const res = await fetch(`/api/truck/schedules?due=1&_=${Date.now()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${t || ''}` } });
        const j = await res.json().catch(() => ({}));
        if (live) setDue(res.ok && j.available ? j.due || [] : []);
      } catch { if (live) setDue([]); }
    })();
    return () => { live = false; };
  }, [supabase, user?.id]);
  if (!due?.length) return null;
  const multi = new Set(due.map((x) => x.truck_id)).size > 1;
  return (
    <section style={card} aria-label="Maintenance due" data-testid="home-maint-due">
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 6px' }}>Maintenance due</h2>
      {due.slice(0, 6).map((x) => (
        <div key={`${x.truck_id}-${x.service_type}`} style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid var(--divider)', padding: '6px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{x.label}{multi && x.unit_number ? ` · Truck ${x.unit_number}` : ''}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{dueText(x)}</div>
          </div>
          <span style={badgeStyle(x.status)}>{STATUS_LABEL[x.status]}</span>
        </div>
      ))}
      {due.length > 6 && <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0' }}>+{due.length - 6} more</p>}
      <Link href="/truck" style={{ color: 'var(--primary)', fontWeight: 600, display: 'inline-block', marginTop: 6, minHeight: 32 }}>Open Truck tab →</Link>
    </section>
  );
}
