'use client';
// 1–4 star rating. Tap sets the rating; tap the current star again to clear it.
// Each star is a 44×44 tap target. Read-only is for lists (stop row, facility reviews).
import { useRef } from 'react';
import { STARS_MAX, STAR_LABELS, toggleStars, rateStarLabel, ratedStarLabel } from '../lib/facilityReviews';

const hit = {
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  padding: 0,
  boxSizing: 'border-box',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontSize: '1.35rem',
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export default function StarRating({ value = 0, onChange, readOnly = false, name = 'Rating', testIdPrefix = 'star', disabled = false }) {
  const n = Number(value);
  const filled = Number.isInteger(n) && n >= 1 && n <= STARS_MAX ? n : 0;
  // The painted value lags a second tap. Keep the latest optimistic rating here
  // when the parent accepts it (returns a number), so the next tap toggles that.
  const live = useRef(filled);
  if (live.current !== filled) live.current = filled;
  if (readOnly && !filled) {
    return <span data-testid={`${testIdPrefix}-readonly`} style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Not rated</span>;
  }
  if (readOnly) {
    return (
      <span role="img" aria-label={ratedStarLabel(filled)} data-testid={`${testIdPrefix}-readonly`} style={{ fontSize: '1.15rem', letterSpacing: '0.12em' }}>
        <span style={{ color: 'var(--star)' }}>{'★'.repeat(filled)}</span>
        <span style={{ color: 'var(--text-muted)' }}>{'☆'.repeat(STARS_MAX - filled)}</span>
      </span>
    );
  }
  return (
    <div role="radiogroup" aria-label={name} data-testid={testIdPrefix} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {Array.from({ length: STARS_MAX }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={filled === n}
          aria-label={rateStarLabel(n)}
          data-testid={`${testIdPrefix}-${n}`}
          onClick={() => {
            if (disabled) return;
            const next = toggleStars(live.current, n);
            const accepted = onChange?.(next);
            if (typeof accepted === 'number') live.current = accepted;
          }}
          style={{ ...hit, color: n <= filled ? 'var(--star)' : 'var(--text-muted)', cursor: disabled ? 'default' : 'pointer' }}
        >{n <= filled ? '★' : '☆'}</button>
      ))}
      {filled > 0 && <span style={{ fontSize: '0.85rem' }}>{STAR_LABELS[filled]}</span>}
    </div>
  );
}
