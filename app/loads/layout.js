'use client';

import { useParams } from 'next/navigation';
import { LoadsProvider, LoadsList } from './LoadsData';

// >= 1024px: loads list on the left, the selected load (/loads/[id]) on the right (pick 2A).
// < 1024px: the aside is display:none (CSS), so /loads and /loads/[id] look and behave as before.
export default function LoadsLayout({ children }) {
  const { id } = useParams() || {};
  return (
    <LoadsProvider>
      <div className={id ? 'loads-split' : undefined}>
        <aside className="loads-aside" aria-label="Loads list">
          {id ? <LoadsList selectedId={id} /> : null}
        </aside>
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    </LoadsProvider>
  );
}
