'use client';
// Visible on every signed-in screen while a share is on: "Sharing location", when it ends, and one-tap Stop.
// Also runs foreground pings (pauses when the tab is hidden or the phone is locked) and the daily until-off nudge.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';
import { authedFetch } from '../lib/authedFetch';
import { nextPingWaitMs, REMIND_TEXT, untilLabel, HEARTBEAT_MS } from '../lib/locationShare';

const pollMs = 30_000;

async function call(path, opts) {
  const sb = getSupabase();
  if (!sb) return { status: 0, body: null };
  const res = await authedFetch(sb.auth, path, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

export default function LocationShareBar() {
  const [share, setShare] = useState(null);
  const [remind, setRemind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const shareRef = useRef(null);
  shareRef.current = share;

  const refresh = useCallback(async () => {
    const r = await call('/api/location-share');
    if (r.body?.setupNeeded || r.status === 401 || r.status === 409) { setShare(null); setRemind(false); return; }
    const s = r.body?.share && r.body.share.live ? r.body.share : null;
    setShare(s);
    setRemind(!!(s && r.body?.remind));
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return undefined;
    let live = true, t = null;
    const go = () => { if (live) refresh(); };
    sb.auth.getSession().then(({ data }) => { if (data?.session && live) go(); });
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) { setShare(null); setRemind(false); return; }
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') go();
    });
    t = setInterval(() => { if (document.visibilityState === 'visible') go(); }, pollMs);
    const vis = () => { if (document.visibilityState === 'visible') go(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('ph-location-share', go);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('ph-location-share', go); sub?.subscription.unsubscribe(); };
  }, [refresh]);

  useEffect(() => {
    document.body.classList.toggle('has-location-share', !!share);
    return () => document.body.classList.remove('has-location-share');
  }, [share]);

  useEffect(() => {
    if (remind && share?.id) call('/api/location-share/reminded', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share_id: share.id }) });
  }, [remind, share?.id]);

  // Foreground pings only while this page is visible.
  useEffect(() => {
    if (!share?.id) return undefined;
    let timer = null, stopped = false;
    const last = { at: null, fix: null, hbAt: null };
    const send = (fix, heartbeat = false) => {
      if (stopped || document.visibilityState !== 'visible') return;
      call('/api/location-share/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_id: share.id, lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy_m, speed_mps: fix.speed_mps, heading: fix.heading, ...(heartbeat ? { heartbeat: true } : {}) }),
      }).then((r) => {
        if (r.body?.code === 'ended' || r.status === 409) refresh();
      }).catch(() => {});
    };
    const read = () => {
      if (stopped || typeof navigator === 'undefined' || !navigator.geolocation) return;
      if (document.visibilityState !== 'visible') return;
      navigator.geolocation.getCurrentPosition(
        (p) => {
          setDenied(false);
          const fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy, speed_mps: p.coords.speed, heading: p.coords.heading };
          const wait = nextPingWaitMs({ lastAt: last.at, prev: last.fix, next: fix, now: Date.now() });
          if (wait === 0) { last.at = Date.now(); last.hbAt = last.at; last.fix = fix; send(fix); }
          // Parked: the next stored point is far off, but say "still open" every ~2.5 min (server only touches a timestamp).
          else if (Date.now() - (last.hbAt || 0) >= HEARTBEAT_MS) { last.hbAt = Date.now(); send(fix, true); }
        },
        (e) => { if (e?.code === 1) setDenied(true); },
        { enableHighAccuracy: false, maximumAge: 30_000, timeout: 15_000 },
      );
    };
    const loop = () => { read(); timer = setTimeout(loop, 15_000); };
    loop();
    const vis = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', vis);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); };
  }, [share?.id, refresh]);

  async function stop() {
    if (!share || busy) return;
    setBusy(true);
    const id = share.id;
    setShare(null);
    setRemind(false);
    const r = await call('/api/location-share/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share_id: id }) });
    setBusy(false);
    if (!r.body?.ok) await refresh();
    window.dispatchEvent(new Event('ph-location-share'));
  }

  if (!share) return null;

  return (
    <div className="location-share-bar" role="status" data-testid="location-share-bar"
      style={{ background: 'var(--warning-bg)', borderBottom: '1px solid var(--warning-border)', color: 'var(--text)', fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '0.45rem var(--gutter)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 48 }}>
        <p style={{ margin: 0, flex: '1 1 200px', fontSize: '0.92rem' }}>
          <strong>Sharing location</strong>
          <span style={{ color: 'var(--text-muted)' }}> · {untilLabel(share)}.</span>
          {' '}Updates pause if you close the app or lock the phone.
          {denied && <span> Location is off on this device — Stop still works, but the map won’t move.</span>}
          {remind && <span> {REMIND_TEXT}</span>}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {remind && (
            <button type="button" data-testid="location-share-keep" onClick={() => setRemind(false)}
              style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 600, cursor: 'pointer' }}>
              Keep sharing
            </button>
          )}
          <Link href="/location" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 12px', color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>Details</Link>
          <button type="button" data-testid="location-share-stop" disabled={busy} onClick={stop}
            style={{ minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700, cursor: 'pointer' }}>
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      </div>
    </div>
  );
}
