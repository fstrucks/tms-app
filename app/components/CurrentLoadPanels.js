'use client';
// Swipeable home "Current load" card (Marc, Oct 18 2026): Panel 1 = the front card (unchanged, passed as children),
// Panel 2 = map + miles left + drive time (LoadMapPanel). Native CSS scroll-snap for one-finger swipes; ‹ › arrows
// and dots for mouse users; WAI-ARIA Tabs ("Load" | "Map") for keyboard and screen readers (← → Home End).
// Panel 2 mounts only after it is first shown, so a driver who never swipes costs no tiles, no API calls and no
// location prompt.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

const LoadMapPanel = dynamic(() => import('./LoadMapPanel'), { ssr: false, loading: () => <PanelPlaceholder /> });

export const PANELS = [{ key: 'load', label: 'Load' }, { key: 'map', label: 'Map' }];

const c = {
  primary: 'var(--primary)', surface: 'var(--surface)', border: 'var(--border)',
  muted: 'var(--text-muted)', soft: 'var(--surface-2)', shadow: '0 1px 3px var(--shadow)',
  onPrimary: 'var(--on-primary)', dot: 'var(--divider)',
};

function PanelPlaceholder() {
  return <div style={{ minHeight: 240, borderRadius: 12, border: `2px solid ${c.border}`, background: c.soft }} />;
}

export default function CurrentLoadPanels({ enabled = true, load, audience, children }) {
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [activeH, setActiveH] = useState(null);
  const track = useRef(null);
  const panels = [useRef(null), useRef(null)];
  const tabs = [useRef(null), useRef(null)];
  const uid = useRef(`clp-${Math.random().toString(36).slice(2, 8)}`).current;
  const settle = useRef(null);
  const fixup = useRef(null);
  const useIso = typeof window === 'undefined' ? useEffect : useLayoutEffect;

  // idx is the source of truth: keep the track on that panel (also after Panel 2 mounts and heights change).
  useIso(() => {
    const t = track.current;
    if (!t || !t.clientWidth) return;
    const want = idx * t.clientWidth;
    if (Math.abs(t.scrollLeft - want) > 2) {
      const smooth = !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
      t.scrollTo({ left: want, behavior: smooth ? 'smooth' : 'auto' });
      // A smooth scroll can be cut short when Panel 2 mounts and heights change: land exactly on the panel.
      clearTimeout(fixup.current);
      fixup.current = setTimeout(() => { if (track.current && Math.abs(track.current.scrollLeft - want) > 2) track.current.scrollTo({ left: want, behavior: 'auto' }); }, 450);
    }
  }, [idx, revealed, activeH]);
  useEffect(() => () => { clearTimeout(settle.current); clearTimeout(fixup.current); }, []);

  // Rotation / window resize changes the panel width: stay on the selected panel (no re-snap to the other one).
  const idxRef = useRef(0); idxRef.current = idx;
  const resizing = useRef(false);
  useEffect(() => {
    const t = track.current;
    if (!t || typeof ResizeObserver === 'undefined') return undefined;
    let w = t.clientWidth;
    const ro = new ResizeObserver(() => {
      if (!t.clientWidth || t.clientWidth === w) return;
      w = t.clientWidth; resizing.current = true;
      t.scrollTo({ left: idxRef.current * w, behavior: 'auto' });
      setTimeout(() => { resizing.current = false; }, 200);
    });
    ro.observe(t);
    return () => ro.disconnect();
  }, [enabled]);

  // The hidden panel takes the shown panel's height (overflow hidden), so the card never leaves a gap.
  useEffect(() => {
    const el = panels[idx].current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const inner = el.firstElementChild || el;
    const h = () => Math.ceil(inner.getBoundingClientRect().height) || null;
    const ro = new ResizeObserver(() => setActiveH(h()));
    ro.observe(inner);
    setActiveH(h());
    return () => ro.disconnect();
  }, [idx, revealed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled) return children;

  function go(i, focus = false) {
    const n = Math.max(0, Math.min(PANELS.length - 1, i));
    setIdx(n);
    if (n === 1) setRevealed(true);
    if (focus) tabs[n].current?.focus();
  }
  // A finger swipe: once scrolling settles on a panel, that panel becomes the selected tab.
  function onScroll() {
    const t = track.current;
    if (!t || !t.clientWidth) return;
    const n = Math.round(t.scrollLeft / t.clientWidth);
    if (n === 1 && !revealed) setRevealed(true);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      if (resizing.current) return;
      const m = Math.round(t.scrollLeft / t.clientWidth);
      if (Math.abs(t.scrollLeft - m * t.clientWidth) > 2) return; // still between panels
      setIdx(m);
      if (m === 1) setRevealed(true);
    }, 120);
  }

  function onKey(e) {
    const k = e.key;
    if (k === 'ArrowRight') { e.preventDefault(); go(idx === PANELS.length - 1 ? 0 : idx + 1, true); }
    else if (k === 'ArrowLeft') { e.preventDefault(); go(idx === 0 ? PANELS.length - 1 : idx - 1, true); }
    else if (k === 'Home') { e.preventDefault(); go(0, true); }
    else if (k === 'End') { e.preventDefault(); go(PANELS.length - 1, true); }
  }

  const arrow = (side) => {
    const disabled = side === 'l' ? idx === 0 : idx === PANELS.length - 1;
    return (
      <button type="button" data-compact data-testid={`panels-arrow-${side}`} aria-label={side === 'l' ? 'Show load panel' : 'Show map panel'}
        aria-controls={`${uid}-p${side === 'l' ? 0 : 1}`} disabled={disabled} onClick={() => go(side === 'l' ? idx - 1 : idx + 1)}
        style={{ width: 36, height: 36, minHeight: 36,
          borderRadius: '50%', border: `1px solid ${c.border}`, background: c.surface, color: c.primary, boxShadow: c.shadow, fontSize: 20, lineHeight: 1,
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
        <span aria-hidden="true">{side === 'l' ? '‹' : '›'}</span>
      </button>
    );
  };

  return (
    <div data-testid="home-load-panels" data-panel={PANELS[idx].key}>
      <style>{`.home-panels{scrollbar-width:none}.home-panels::-webkit-scrollbar{display:none}
@media (prefers-reduced-motion: reduce){.home-panels{scroll-behavior:auto}}`}</style>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <div role="tablist" aria-label="Current load views" onKeyDown={onKey}
          style={{ display: 'inline-flex', gap: 4, background: c.soft, borderRadius: 8, padding: 3 }}>
          {PANELS.map((p, i) => (
            <button key={p.key} ref={tabs[i]} type="button" role="tab" data-compact className="home-panels-tab" id={`${uid}-t${i}`}
              data-testid={`panels-tab-${p.key}`} aria-selected={idx === i} aria-controls={`${uid}-p${i}`} tabIndex={idx === i ? 0 : -1}
              onClick={() => go(i)}
              style={{ minHeight: 32, padding: '0 14px', border: 0, borderRadius: 6, fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
                background: idx === i ? c.surface : 'transparent', color: idx === i ? c.primary : c.muted, boxShadow: idx === i ? c.shadow : 'none' }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div ref={track} className="home-panels" onScroll={onScroll}
          style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain', alignItems: 'flex-start', borderRadius: 12 }}>
          {PANELS.map((p, i) => (
            <div key={p.key} ref={panels[i]} role="tabpanel" id={`${uid}-p${i}`} aria-labelledby={`${uid}-t${i}`} data-testid={`panel-${p.key}`}
              inert={idx === i ? undefined : ''} aria-hidden={idx === i ? undefined : true}
              style={{ flex: '0 0 100%', minWidth: 0, scrollSnapAlign: 'start', scrollSnapStop: 'always',
                ...(idx !== i && activeH ? { height: activeH, overflow: 'hidden' } : {}) }}>
              {i === 0 ? children : (revealed ? <LoadMapPanel load={load} audience={audience} active={idx === 1} /> : <PanelPlaceholder />)}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, marginTop: 8 }}>
        {arrow('l')}
        <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {PANELS.map((p, i) => (
            <button key={p.key} type="button" tabIndex={-1} data-compact className="home-panels-dot" data-testid={`panels-dot-${p.key}`} onClick={() => go(i)}
              style={{ minHeight: 0, height: 10, width: idx === i ? 24 : 10, padding: 0, border: 0, borderRadius: 5, cursor: 'pointer', background: idx === i ? c.primary : c.dot }} />
          ))}
        </div>
        {arrow('r')}
      </div>
    </div>
  );
}
