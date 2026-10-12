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
        {/* Only render the side list when a load is selected, so /loads has no empty panel. */}
        {id ? (
          <aside className="loads-aside" aria-label="Loads list" style={{ fontFamily: 'system-ui' }}>
            <LoadsList selectedId={id} />
          </aside>
        ) : null}
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    </LoadsProvider>
  );
}
