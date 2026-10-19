// Preview-only wireframe of the proposed Truck tab (docs/truck-tab-plan.md). Fake data, no DB calls.
// 404 in production (VERCEL_ENV=production), like /dev/signature. Server component; nothing is clickable-for-real.
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { expiryBadge, latestWeight, fieldValuesFromRows } from '../../lib/truckFields';

export const dynamic = 'force-dynamic';

const TODAY = '2026-10-17';
const FAKE = {
  truck: { unit_number: '104', license_plate: 'TEST104', license_state: 'CA', vin: '1FAKEVXN0TEST0104', empty_weight_lb: 19850 },
  trailer: { unit_number: 'T-22', license_plate: 'TRL0022', license_state: 'CA', empty_weight_lb: 14600 },
  driver: { name: 'Pat Driver (FAKE)', phone: '555-010-0104', cdl_number: 'D0000000', cdl_state: 'CA', cdl_expiry: '2027-03-01', med_card_expiry: '2026-11-02' },
  history: [
    { id: 1, ticket_date: '2026-10-16', gross_weight_lb: 78420, scale_name: 'CAT Scale #000 (FAKE), Testville CA', created_at: '2026-10-16T15:00:00Z' },
    { id: 2, ticket_date: '2026-10-09', gross_weight_lb: 71260, scale_name: 'CAT Scale #001 (FAKE)', created_at: '2026-10-09T15:00:00Z' },
    { id: 3, ticket_date: '2026-10-02', gross_weight_lb: 34510, scale_name: 'Empty weigh (FAKE)', created_at: '2026-10-02T15:00:00Z' },
  ],
};
const lb = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-US')} lb`);
const mdy = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const TONES = { green: ['var(--success-bg)', 'var(--success)'], yellow: ['var(--warning-bg)', 'var(--warning)'], orange: ['var(--warning-bg)', 'var(--warning)'], red: ['var(--danger-bg)', 'var(--danger)'], 'red-strong': ['var(--danger)', 'var(--surface)'], grey: ['var(--surface-2)', 'var(--text)'] };
const card = { background: 'var(--surface)', border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' };
const h2 = { fontSize: 18, margin: '0 0 0.75rem' };
const row = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid var(--divider)', fontSize: 15 };
const k = { color: 'var(--text-muted)' };
const btn = { display: 'block', width: '100%', minHeight: 48, borderRadius: 10, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontSize: 16, fontWeight: 600, marginTop: 12 };

function Badge({ date, what }) {
  const b = expiryBadge(date, TODAY); const [bg, fg] = TONES[b.tone];
  return <span data-testid={`badge-${what}`} style={{ padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{b.label}</span>;
}
function Row({ label, children }) { return <div style={row}><span style={k}>{label}</span><span style={{ textAlign: 'right', fontWeight: 500 }}>{children}</span></div>; }

export default function Page() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  const v = fieldValuesFromRows(FAKE);
  const latest = latestWeight(FAKE.history);
  const d = FAKE.driver;
  return (
    <main data-testid="truck-wireframe" style={{ fontFamily: 'system-ui', padding: '1rem', maxWidth: 680, margin: '0 auto', boxSizing: 'border-box', background: 'var(--surface-2)' }}>
      <p style={{ background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 8, padding: '6px 10px', fontSize: 13, margin: '0 0 0.75rem' }}>Wireframe only · fake data · nothing is saved</p>
      <h1 style={{ fontSize: 24, margin: '0 0 0.75rem' }}>Truck</h1>
      <label style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Truck <select disabled style={{ minHeight: 40, fontSize: 15, marginLeft: 6 }}><option>#{v.truck_number}</option></select> <span style={{ fontSize: 12 }}>(picker appears when there are 2+ trucks)</span></label>

      <section style={card} aria-label="Truck & Trailer">
        <h2 style={h2}>Truck &amp; Trailer</h2>
        <Row label="Truck number">#{v.truck_number}</Row>
        <Row label="Truck plate">{v.truck_plate} · {v.truck_plate_state}</Row>
        <Row label="VIN">{FAKE.truck.vin}</Row>
        <Row label="Empty weight (truck)">{lb(FAKE.truck.empty_weight_lb)}</Row>
        <Row label="Trailer number">{v.trailer_number}</Row>
        <Row label="Trailer plate">{v.trailer_plate} · {v.trailer_plate_state}</Row>
        <Row label="Empty weight (trailer)">{lb(FAKE.trailer.empty_weight_lb)}</Row>
        <button type="button" style={{ ...btn, background: 'var(--surface)', color: 'var(--primary)', border: '1px solid var(--primary)' }}>Edit</button>
      </section>

      <section style={card} aria-label="Scale weights">
        <h2 style={h2}>Scale weights</h2>
        <div data-testid="latest-weight" style={{ background: 'var(--info-bg)', borderRadius: 10, padding: '0.75rem', marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: 'var(--primary)' }}>Latest weight · {mdy(latest.ticket_date)}</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)' }}>{lb(latest.gross_weight_lb)}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{latest.scale_name}</div>
        </div>
        <ul data-testid="weight-history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {FAKE.history.map((h) => <li key={h.id} style={row}><span>{mdy(h.ticket_date)} <span style={{ ...k, fontSize: 13 }}>· {h.scale_name}</span></span><strong style={{ whiteSpace: 'nowrap' }}>{lb(h.gross_weight_lb)}</strong></li>)}
        </ul>
        <button type="button" data-testid="scan-scale-ticket" style={btn}>📷 Scan scale ticket</button>
        <p style={{ ...k, fontSize: 12, margin: '6px 0 0' }}>Reads the weight and date. You check it before it's added.</p>
      </section>

      <section style={card} aria-label="Driver">
        <h2 style={h2}>Driver</h2>
        <Row label="Name">{v.driver_name}</Row>
        <Row label="Phone">{d.phone}</Row>
        <Row label="CDL">{d.cdl_number} · {d.cdl_state}</Row>
        <Row label="CDL expires"><span>{mdy(d.cdl_expiry)} <Badge date={d.cdl_expiry} what="cdl" /></span></Row>
        <Row label="Med card expires"><span>{mdy(d.med_card_expiry)} <Badge date={d.med_card_expiry} what="med" /></span></Row>
        <Row label="Drives">Truck #{v.truck_number}</Row>
        <button type="button" style={{ ...btn, background: 'var(--surface)', color: 'var(--primary)', border: '1px solid var(--primary)' }}>Edit</button>
      </section>

      <section style={card} aria-label="Company">
        <h2 style={h2}>Company</h2>
        <Link href="/company" data-testid="company-link" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, fontSize: 16, color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>Company profile, insurance &amp; documents <span aria-hidden>›</span></Link>
      </section>
    </main>
  );
}
