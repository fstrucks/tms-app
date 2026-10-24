'use client';
// Fake shipper and receiver so the rating control can be tried without a signed-in load.
import LoadReviews from '../../components/LoadReviews';
import { summarizeStars } from '../../lib/facilityReviews';

const load = {
  id: 'preview-load',
  stops: [
    { id: 'preview-shipper', sequence: 1, stop_type: 'pickup', company_name: 'TEST Foods Dock', completion: 'done' },
    { id: 'preview-receiver', sequence: 2, stop_type: 'delivery', company_name: 'TEST Grocery DC', completion: 'done' },
  ],
};

const list = [
  { id: 'a', stars: 4, stop_type: 'pickup', created_at: '2026-10-02T15:00:00Z', better_note: 'Check in at the guard shack. Vest required.' },
  { id: 'b', stars: 3, stop_type: 'delivery', created_at: '2026-07-14T18:00:00Z', better_note: 'Long wait at the door. Appointment was kept.' },
  { id: 'c', stars: null, stop_type: 'pickup', created_at: '2026-10-20T16:00:00Z', better_note: 'Vest required. No score this visit.' },
];

const summary = summarizeStars(list);

export default function ReviewsPreview() {
  return (
    <main style={{ padding: '1rem', maxWidth: 720, margin: '0 auto' }} data-testid="reviews-preview">
      <h1 style={{ fontSize: '1.3rem', margin: '0 0 0.75rem' }}>Reviews</h1>
      <LoadReviews
        load={load}
        preview={{
          reviews: { 'preview-shipper': { stars: 3 }, 'preview-receiver': { stars: 0 } },
          summaries: [{ id: 'preview-facility', name: 'TEST Foods Dock', avg: summary.avg, count: summary.count, href: '#review-list' }],
          list,
        }}
      />
    </main>
  );
}
