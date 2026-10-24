'use client';
// Summary row and one public review. No names. Gold stars are filled; an empty score says Not rated.
import Link from 'next/link';
import { ratingSummary, reviewVisitLabel } from '../lib/facilityReviews';
import StarRating from './StarRating';

const card = { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', background: 'var(--surface)' };

export function RatingSummaryRow({ name, avg, count, href }) {
  const text = ratingSummary(avg, count);
  const style = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    minHeight: 44, padding: '10px 12px', marginBottom: '0.75rem', boxSizing: 'border-box',
    border: '1px solid var(--divider)', borderRadius: 12, background: 'var(--surface)',
    textDecoration: 'none', color: 'var(--text)',
  };
  const body = (
    <>
      <span style={{ minWidth: 0 }}>
        {name ? <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>{name}</span> : null}
        <span data-testid="review-summary-text" style={{ fontWeight: 700, fontSize: '1.15rem' }}>{text}</span>
      </span>
      {href ? <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1, color: 'var(--text-muted)' }}>›</span> : null}
    </>
  );
  if (!href) return <div data-testid="review-summary" style={style}>{body}</div>;
  return <Link data-testid="review-summary" href={href} aria-label={name ? `${name}. ${text}. All reviews` : `${text}. All reviews`} style={style}>{body}</Link>;
}

export function PublicReviewCard({ review, aside = null, testId = 'review-list-item' }) {
  const label = reviewVisitLabel(review);
  const edited = review?.updated_at && review.updated_at !== review.created_at ? ' (edited)' : '';
  return (
    <article data-testid={testId} style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StarRating value={review?.stars} readOnly testIdPrefix={`pub-${review?.id || 'review'}`} />
          {label ? <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 4 }}>{label}{edited}</div> : null}
        </div>
        {aside}
      </div>
      {review?.better_note ? <p style={{ margin: '6px 0 0' }}><strong>Could be better:</strong> {review.better_note}</p> : null}
      {review?.need_to_know ? <p style={{ margin: '6px 0 0' }}><strong>Need to know:</strong> {review.need_to_know}</p> : null}
    </article>
  );
}
