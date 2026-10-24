'use client';
// Fake shipper and receiver so the rating control can be tried without a signed-in load.
import LoadReviews from '../../components/LoadReviews';
import StarRating from '../../components/StarRating';

const load = {
  id: 'preview-load',
  stops: [
    { id: 'preview-shipper', sequence: 1, stop_type: 'pickup', company_name: 'TEST Foods Dock', completion: 'done' },
    { id: 'preview-receiver', sequence: 2, stop_type: 'delivery', company_name: 'TEST Grocery DC', completion: 'done' },
  ],
};

const saved = [
  { id: 'a', stars: 3, place: 'Shipper · TEST Foods Dock', note: 'Check in at the guard shack. Vest required.' },
  { id: 'b', stars: 1, place: 'Receiver · TEST Grocery DC', note: 'Long wait at the door.' },
];

export default function ReviewsPreview() {
  return (
    <main style={{ padding: '1rem', maxWidth: 720, margin: '0 auto' }} data-testid="reviews-preview">
      <h1 style={{ fontSize: '1.3rem', margin: '0 0 0.75rem' }}>Reviews</h1>
      <LoadReviews
        load={load}
        preview={{ reviews: { 'preview-shipper': { stars: 3 }, 'preview-receiver': { stars: 0 } } }}
      />
      <h2 style={{ fontSize: '1rem', margin: '1rem 0 0.25rem' }}>Posted reviews</h2>
      <p style={{ margin: '0 0 0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Read only. What other drivers shared.</p>
      {saved.map((r) => (
        <div key={r.id} data-testid="preview-review" style={{ border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', background: 'var(--surface)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.place}</div>
          <StarRating value={r.stars} readOnly />
          <p style={{ margin: '6px 0 0' }}>{r.note}</p>
        </div>
      ))}
    </main>
  );
}
