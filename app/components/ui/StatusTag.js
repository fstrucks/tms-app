import { statusColors, statusLabel } from '../../lib/statusColors';

// Load status tag: colored pill + text label. Colors come from CSS variables so globals.css can
// switch to the dark set under prefers-color-scheme: dark.
export default function StatusTag({ status }) {
  const c = statusColors(status);
  return (
    <span className="status-tag" data-status={String(status ?? '') || 'unknown'}
      style={{ '--st-bg': c.light[0], '--st-fg': c.light[1], '--st-bg-d': c.dark[0], '--st-fg-d': c.dark[1],
        border: c.dashed ? '1px dashed currentColor' : '1px solid transparent',
        borderRadius: 999, padding: '0.15rem 0.6rem', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
      {statusLabel(status)}
    </span>
  );
}
