'use client';
// Route options, Phase 1 (display only). Nothing loads until "Route options" is opened. Fastest is the default;
// picking a chip changes only the drawn line and the miles/time on this card (via onSelect). Radio group pattern:
// arrow keys move and select, ✓ marks the selected chip, the choice is announced.
import { useRef, useState } from 'react';
import { callMap } from '../lib/mapClient';
import { viewOfReply, chipDetail, announceText, nextIndex, OPTIONS_TEXT } from '../lib/routeOptions';

const srOnly = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const chipBase = { minHeight: 44, minWidth: 44, padding: '6px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', font: 'inherit', display: 'inline-flex', flexDirection: 'column', justifyContent: 'center', gap: 1 };

export default function RouteOptions({ loadId, getToken, selected = 'fastest', onSelect, onOptions, homeNote = false, testid = 'route-options' }) {
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState(null);
  const [announce, setAnnounce] = useState('');
  const loading = useRef(false);
  const btns = useRef([]);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;

  async function load() {
    if (loading.current) return;
    loading.current = true; setReply(null);
    try {
      const j = await callMap({ url: `/api/loads/${loadId}/map/options`, method: 'POST', getToken });
      setReply(j);
      if (j?.state === 'ready') onOptions?.(j.options);
    } finally { loading.current = false; }
  }
  function toggle() {
    const next = !open; setOpen(next);
    if (next && (!reply || reply.state !== 'ready') && online) load();
  }

  const v = open ? viewOfReply(reply, { online }) : null;
  if (v?.kind === 'hidden') return null;
  const list = v?.options || [];
  const selIdx = Math.max(0, list.findIndex((o) => o.id === selected || o.ids?.includes(selected)));

  function pick(i) {
    const o = list[i]; if (!o) return;
    onSelect?.(o.id === 'fastest' || o.ids?.includes('fastest') ? null : o);
    setAnnounce(announceText(o));
  }
  function onKey(e, i) {
    const n = nextIndex(i, e.key, list.length);
    if (n === i || n < 0) return;
    e.preventDefault(); pick(n); btns.current[n]?.focus();
  }

  return (
    <div data-testid={testid} style={{ marginTop: 8 }}>
      <button type="button" aria-expanded={open} aria-controls={`${testid}-panel`} onClick={toggle} data-testid={`${testid}-toggle`}
        style={{ minHeight: 44, padding: '6px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
        Route options {open ? '▴' : '▾'}
      </button>
      {open && (
        <div id={`${testid}-panel`} style={{ marginTop: 8 }}>
          {(v.kind === 'loading') && <p role="status" style={{ color: 'var(--text-muted)', margin: '4px 0' }}>{v.text}</p>}
          {(v.kind === 'offline' || v.kind === 'error' || v.kind === 'busy' || v.kind === 'not_ready') && (
            <div role="status" data-testid={`${testid}-msg`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: v.kind === 'not_ready' ? 'var(--text-muted)' : 'var(--warning)' }}>{v.text}</span>
              {v.kind !== 'not_ready' && <button type="button" onClick={load} disabled={!online}
                style={{ minHeight: 44, padding: '6px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit', cursor: 'pointer' }}>Try again</button>}
            </div>
          )}
          {(v.kind === 'list' || v.kind === 'one') && (
            <>
              <div role="radiogroup" aria-label="Route options" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {list.map((o, i) => {
                  const on = i === selIdx;
                  return (
                    <button key={o.id} ref={(el) => { btns.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                      data-testid={`${testid}-chip-${o.id}`} onClick={() => pick(i)} onKeyDown={(e) => onKey(e, i)}
                      style={{ ...chipBase, border: on ? '2px solid var(--primary)' : '1px solid var(--border)', background: on ? 'var(--primary-soft)' : 'var(--surface)', color: 'var(--text)' }}>
                      <span style={{ fontWeight: 700 }}>{on ? '✓ ' : ''}{o.label}</span>
                      <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{chipDetail(o)}</span>
                    </button>
                  );
                })}
              </div>
              {v.text && <p data-testid={`${testid}-only-one`} style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>{v.text}</p>}
              {v.partial && <p role="status" style={{ color: 'var(--warning)', fontSize: '0.85rem', margin: '6px 0 0' }}>{v.partial}</p>}
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '6px 0 0' }}>{OPTIONS_TEXT.hint}{homeNote ? ` ${OPTIONS_TEXT.homeNote}` : ''}</p>
            </>
          )}
        </div>
      )}
      <div aria-live="polite" style={srOnly}>{announce}</div>
    </div>
  );
}
