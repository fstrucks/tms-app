'use client';

// Shared loading / error states for data lists. Pages show their empty state only when
// a fetch has finished without error and returned nothing.

export function Loading({ label = 'Loading…' }) {
  return (
    <div role="status" aria-live="polite" style={{ padding: '0.25rem 0' }}>
      <span style={{ position: 'absolute', width: 1, height: 1, margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true" style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', background: '#fff' }}>
          <div style={{ height: 14, width: '55%', background: '#eef2f7', borderRadius: 6, marginBottom: 10 }} />
          <div style={{ height: 12, width: '80%', background: '#f3f5f9', borderRadius: 6 }} />
        </div>
      ))}
      <p aria-hidden="true" style={{ color: '#6b7280', fontSize: '0.85rem', margin: 0 }}>{label}</p>
    </div>
  );
}

export function LoadError({ message = "Couldn't load this. Check your connection and try again.", onRetry }) {
  return (
    <div role="alert" style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 12, padding: '0.75rem', marginBottom: '0.75rem',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
      <span style={{ color: '#b91c1c' }}>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}
          style={{ minHeight: 44, padding: '0 1rem', borderRadius: 8, border: '1px solid #b91c1c', background: '#fff', color: '#b91c1c', fontSize: '1rem' }}>
          Retry
        </button>
      )}
    </div>
  );
}
