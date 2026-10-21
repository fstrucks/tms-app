'use client';
// Home card Panel 2: map with the truck route from the driver's position to the next stop, miles left, Drive time
// (ideal conditions, no traffic data), ETA in the stop's time zone, and Navigate buttons (Trucker Path, Google Maps,
// Apple Maps) + Copy address. Mounted only after Panel 2 is first shown (CurrentLoadPanels).
// PRIVACY: the position stays in memory (refs/state) only: never in localStorage, cookies or the URL, never logged,
// never stored on the server. It is read only while this panel is showing and the page is visible. Only two on/off
// flags (opted in / auto-start off) live in localStorage (lib/autoLocation).
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { callMap } from '../lib/mapClient';
import { getSupabase } from '../lib/supabase';
import { sortedStops } from '../lib/loadTabs';
import { readAutoLocation, markOptedIn, shouldAutoStart, showLocationButton, queryGeoPermission, deniedHelp } from '../lib/autoLocation';
import { nextStopIndex, STOP_LABEL } from '../lib/homeCurrentLoad';
import { supportsStopCompletion } from '../lib/stopProgress';
import { fmtApptWindow } from '../lib/loads';
import {
  LOCATION_POLL_MS, AGE_TICK_MS, LOCATING_MAX_MS, nextAgeTickMs, LAST_GOOD_MAX_MS, ERROR_RETRY_MS, NEAR_STOP_MI, shouldRefresh, estimate, fixUsable, coarseFixNote, haversineMi,
  fmtDriveTime, fmtMilesLeft, fmtEta, etaTarget, totalRouteMiles, ageText, postEta, ETA_ERROR_TEXT, platformOf,
  stopAddress, googleMapsUrl, appleMapsUrl, truckerPathLink, TP_FALLBACK_MS,
} from '../lib/loadEta';

const RouteMap = dynamic(() => import('./RouteMap'), { ssr: false, loading: () => <div style={{ height: 'clamp(180px, 42vw, 280px)', borderRadius: 10, background: 'var(--surface-2)' }} /> });

const c = {
  surface: 'var(--surface)', soft: 'var(--surface-2)', text: 'var(--text)', muted: 'var(--text-muted)',
  border: 'var(--border)', infoBorder: 'var(--primary-soft)', primary: 'var(--primary)', onPrimary: 'var(--on-primary)',
  success: 'var(--success)', warning: 'var(--warning)', warningBg: 'var(--warning-bg)', warningBorder: 'var(--warning-border)',
  danger: 'var(--danger)',
};
const s = {
  card: { border: `2px solid ${c.infoBorder}`, borderRadius: 12, padding: '0.9rem', background: c.surface, color: c.text, minWidth: 0 },
  lbl: { fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: c.primary },
  muted: { color: c.muted, fontSize: '0.85rem' },
  chip: { display: 'inline-block', border: `1px solid ${c.border}`, borderRadius: 8, padding: '0.25rem 0.5rem', fontSize: '0.82rem', background: c.soft, margin: '0 0.4rem 0.4rem 0' },
  btn: { flex: '1 1 140px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, padding: '0 12px', borderRadius: 8, border: `1px solid ${c.primary}`, color: c.primary, background: c.surface, fontWeight: 600, fontSize: '0.92rem', textDecoration: 'none', cursor: 'pointer' },
  btnPri: { background: c.primary, color: c.onPrimary },
};

const tokenOf = (supabase) => async (fresh) => {
  if (fresh) { try { await supabase.auth.refreshSession(); } catch {} }
  return (await supabase.auth.getSession())?.data?.session?.access_token || '';
};

async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

export default function LoadMapPanel({ load, supabase: sbProp = null, audience, active = true }) {
  const supabase = sbProp || getSupabase();
  const [view, setView] = useState(null);          // GET: stops + stored route
  const [perm, setPerm] = useState('unknown');     // unknown | prompt | granted | denied | unsupported
  const [fix, setFix] = useState(null);            // { lat, lng, accuracy, at } (memory only)
  const [last, setLast] = useState(null);          // { miles, seconds, geometry, at, origin, stopId }
  const [err, setErr] = useState(null);            // { code, at }
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [announce, setAnnounce] = useState('');
  const [copied, setCopied] = useState(false);
  const [locating, setLocating] = useState(false); // waiting for a GPS fix (after Use my location / a poll with no fix yet)
  const locTimer = useRef(null);
  const block = useRef(null);                      // { until, noRouteAt }
  const inflight = useRef(false);
  const lastRef = useRef(null); lastRef.current = last;
  const gotFix = useRef(false);                    // once a fix arrived, a later "prompt" from the Permissions API doesn't stop polling
  const platform = typeof navigator !== 'undefined' ? platformOf(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints || 0 }) : 'desktop';

  const stops = sortedStops(load);
  const ni = nextStopIndex(load, now);
  const loadStop = stops[ni] || null;
  const vStop = view?.stops?.find((x) => x.id === loadStop?.id);
  const stop = loadStop ? { ...loadStop, lat: vStop?.lat ?? loadStop.lat ?? null, lng: vStop?.lng ?? loadStop.lng ?? null, timezone: loadStop.timezone ?? vStop?.timezone ?? null } : null;
  const hasStopPin = stop && stop.lat != null && stop.lng != null;

  // Stored route (no ORS call).
  useEffect(() => {
    let live = true;
    callMap({ url: `/api/loads/${load.id}/eta`, method: 'GET', getToken: tokenOf(supabase) })
      .then((j) => { if (live) setView(j && j.state === 'ready' ? j : { state: 'failed', message: j?.message || 'Couldn’t load the map.' }); })
      .catch(() => { if (live) setView({ state: 'failed', message: 'Couldn’t load the map.' }); });
    return () => { live = false; };
  }, [load.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Permission state without prompting (Permissions API, with a fallback when it's missing). Auto-start rules: lib/autoLocation.
  const [prefs, setPrefs] = useState({ optedIn: false, enabled: true });
  useEffect(() => { setPrefs(readAutoLocation(typeof window !== 'undefined' ? window.localStorage : null)); }, []);
  useEffect(() => {
    if (typeof navigator === 'undefined' || (typeof window !== 'undefined' && window.isSecureContext === false)) { setPerm('unsupported'); return undefined; }
    let st = null; let live = true;
    const upd = () => setPerm(st.state === 'granted' ? 'granted' : st.state === 'denied' ? 'denied' : (gotFix.current ? 'granted' : 'prompt'));
    queryGeoPermission(navigator).then((r) => { if (!live) return; if (r.status) { st = r.status; upd(); r.status.onchange = upd; } else setPerm(r.state); });
    return () => { live = false; if (st) st.onchange = null; };
  }, []);
  const auto = shouldAutoStart(perm, prefs);

  const stopLocating = () => { setLocating(false); if (locTimer.current) { clearTimeout(locTimer.current); locTimer.current = null; } };
  useEffect(() => () => { if (locTimer.current) clearTimeout(locTimer.current); }, []);

  // "Finding your location…" shows from the read until a fix, an error or a timeout (browser timeout 15 s, plus a
  // LOCATING_MAX_MS backstop for browsers that never call back, e.g. a dismissed prompt).
  function readLocation({ quiet = false } = {}) {
    if (!navigator.geolocation) return;
    if (!quiet) {
      setLocating(true);
      if (locTimer.current) clearTimeout(locTimer.current);
      locTimer.current = setTimeout(() => { locTimer.current = null; setLocating(false); }, LOCATING_MAX_MS);
    }
    navigator.geolocation.getCurrentPosition(
      (p) => { stopLocating(); gotFix.current = true; markOptedIn(typeof window !== 'undefined' ? window.localStorage : null); setPerm('granted'); setFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }); },
      (e) => { stopLocating(); if (e?.code === 1) { gotFix.current = false; setPerm('denied'); } else setErr((x) => x || { code: 'no_fix', at: Date.now() }); },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
    );
  }

  // QA #96: the clock behind "Updated N min ago" (and the between-calls estimate and ETA) runs while this panel is
  // showing and the page is visible, independent of location polling and server calls. r2: each tick is scheduled
  // for just after the next whole minute since the last answer (nextAgeTickMs), at most AGE_TICK_MS apart, so the
  // label flips exactly on time instead of up to 30 s late.
  const ageAt = last?.at || null;
  useEffect(() => {
    if (!active) return undefined;
    let t = null;
    const tick = () => {
      const n = Date.now();
      if (document.visibilityState === 'visible') setNow(n);
      t = setTimeout(tick, nextAgeTickMs(ageAt, n));
    };
    tick();
    const vis = () => { if (document.visibilityState === 'visible') { clearTimeout(t); tick(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', vis); };
  }, [active, ageAt]);

  // Poll once a minute, only while this panel is showing and the page is visible.
  useEffect(() => {
    // granted → automatic (unless Auto-start is off); prompt → automatic only after an earlier successful tap.
    // After a manual tap in this session (gotFix) keep polling even if Auto-start is off.
    if (!active || !(auto || (perm === 'granted' && gotFix.current))) return undefined;
    const tick = () => { setNow(Date.now()); if (document.visibilityState === 'visible') readLocation({ quiet: gotFix.current }); };
    tick();
    const t = setInterval(tick, LOCATION_POLL_MS);
    const vis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [active, perm, auto]); // eslint-disable-line react-hooks/exhaustive-deps

  async function route(manual = false) {
    if (inflight.current || !view?.live || !hasStopPin) return;
    const d = shouldRefresh({ last: lastRef.current, fix, stop, now: Date.now(), manual, block: block.current });
    if (!d.go) return;
    inflight.current = true; setBusy(true);
    try {
      const j = await postEta({ url: `/api/loads/${load.id}/eta`, body: { lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy, stop_id: stop.id }, getToken: tokenOf(supabase) });
      if (j?.state === 'ready') {
        const at = Date.now();
        setLast({ miles: j.miles, seconds: j.seconds, geometry: j.geometry, at, origin: { lat: fix.lat, lng: fix.lng }, stopId: stop.id });
        setErr(null); block.current = null;
        if (manual) setAnnounce(`${fmtMilesLeft(j.miles)}, drive time ${fmtDriveTime(j.seconds) || 'unknown'}, ${etaTarget(load, ni)}.`);
      } else if (j?.state === 'no_key') {
        setView((v) => (v ? { ...v, live: false } : v));
      } else {
        const code = j?.code || 'upstream';
        setErr({ code, at: Date.now() });
        block.current = code === 'no_route' ? { noRouteAt: { lat: fix.lat, lng: fix.lng } } : { until: Date.now() + (j?.retryInMs || ERROR_RETRY_MS) };
      }
    } finally { inflight.current = false; setBusy(false); }
  }

  useEffect(() => { if (active && fix) route(false); }, [fix, active, stop?.id, view?.live]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- what to show ----
  const fresh = last && last.stopId === stop?.id && now - last.at <= LAST_GOOD_MAX_MS ? last : null;
  const usableFix = fixUsable(fix, now) ? fix : null;
  const est = fresh ? estimate(fresh, usableFix, stop) : null;
  const toStop = usableFix && hasStopPin ? haversineMi(usableFix, stop) : null;
  const near = toStop != null && toStop <= NEAR_STOP_MI;
  const total = totalRouteMiles(load, view);
  const target = etaTarget(load, ni);
  const eta = est?.seconds != null ? fmtEta(now, est.seconds, stop?.timezone) : null;
  const appt = stop ? fmtApptWindow(stop.appointment_start, stop.appointment_end, stop.timezone) : null;
  const errText = err && !fresh ? ETA_ERROR_TEXT[err.code] : (err && fresh && err.code !== 'no_fix' ? ETA_ERROR_TEXT[err.code] : null);
  const tp = truckerPathLink(stop, platform);
  const gm = googleMapsUrl(stop), am = appleMapsUrl(stop);
  const addr = stopAddress(stop);

  function openTruckerPath(e) {
    if (!tp?.fallback) return; // Android intent: URL carries its own Play Store fallback
    e.preventDefault();
    let left = false;
    const away = () => { left = true; };
    window.addEventListener('pagehide', away, { once: true });
    document.addEventListener('visibilitychange', away, { once: true });
    window.location.href = tp.href;
    setTimeout(() => {
      window.removeEventListener('pagehide', away); document.removeEventListener('visibilitychange', away);
      if (!left && document.visibilityState === 'visible') window.location.href = tp.fallback; // app not installed → App Store
    }, TP_FALLBACK_MS);
  }
  async function onCopy() {
    if (!addr) return;
    if (await copyText(addr)) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  }

  let headline;
  if (near) headline = <div data-testid="eta-near" style={{ fontSize: '1.3rem', fontWeight: 800 }}>At or near the {STOP_LABEL(stop).toLowerCase()}</div>;
  else if (est) {
    headline = (
      <div data-testid="eta-live">
        <div style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.01em' }}>
          <span data-testid="eta-miles">{fmtMilesLeft(est.miles)}</span> <span style={{ fontSize: '1rem', fontWeight: 600, color: c.muted }}>left {target}</span>
        </div>
        <div style={{ fontSize: '1rem', marginTop: 2 }}>
          <b>Drive time</b> <span data-testid="eta-drive">{fmtDriveTime(est.seconds) || '—'}</span>
          {eta && <> · <b>ETA</b> <span data-testid="eta-arrival">{eta}</span></>}
        </div>
        <div data-testid="eta-ideal" style={{ ...s.muted, fontSize: '0.78rem', marginTop: 2 }}>Ideal conditions: no traffic, breaks or fuel stops.</div>
      </div>
    );
  } else {
    headline = (
      <div data-testid="eta-total">
        <div style={{ fontSize: '1.25rem', fontWeight: 800 }}>{total ? `${Number(total).toLocaleString('en-US')} mi` : '—'} <span style={{ fontSize: '0.95rem', fontWeight: 600, color: c.muted }}>total route</span></div>
      </div>
    );
  }

  let locLine = null;
  if (!view?.live || !hasStopPin) locLine = !hasStopPin && view ? ETA_ERROR_TEXT.no_stop_location : null;
  else if (perm === 'unsupported') locLine = 'This browser can’t share location, so live miles aren’t available.';
  else if (perm === 'denied') locLine = deniedHelp(platform);
  else if (locating && !fresh) locLine = null; // "Finding your location…" below
  else if (perm === 'prompt' || perm === 'unknown' || (perm === 'granted' && !auto && !fix)) locLine = 'Turn on location to see miles and drive time left. It’s used only while this screen is open and is never saved.';

  return (
    <section data-testid="home-load-map" aria-label="Current load map and miles left" style={s.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={s.lbl}>Current load · route</div>
        {stop && <span style={s.muted}>Next: {STOP_LABEL(stop)}{stop.city ? ` · ${stop.city}${stop.state ? `, ${stop.state}` : ''}` : ''}</span>}
      </div>
      <div style={{ margin: '0.6rem 0' }}>
        {view?.state === 'ready' && (view.stops || []).some((x) => x.lat != null)
          ? <RouteMap stops={view.stops} geometry={view.geometry} doneIds={supportsStopCompletion(load) ? stops.filter((x, i) => x.completed_at || i < ni).map((x) => x.id) : []} truck={usableFix ? { lat: usableFix.lat, lng: usableFix.lng } : null} live={fresh?.geometry || null}
              label={`Map: truck route ${target}${est ? `, ${fmtMilesLeft(est.miles)} left` : ''}`} />
          : <div style={{ height: 140, borderRadius: 10, background: c.soft, display: 'flex', alignItems: 'center', justifyContent: 'center', ...s.muted }}>
              {view ? (view.state === 'failed' ? view.message : 'No map yet') : 'Loading the map…'}</div>}
      </div>
      {headline}
      {usableFix && coarseFixNote(usableFix) && <p data-testid="eta-coarse" style={{ ...s.muted, fontSize: '0.8rem', margin: '4px 0 0' }}>{coarseFixNote(usableFix)}</p>}
      {usableFix && !est && !near && !errText && busy && <p data-testid="eta-working" role="status" style={{ ...s.muted, margin: '4px 0 0' }}>Working out miles left…</p>}
      {stop && (
        <div style={{ fontSize: '0.9rem', marginTop: 6 }}>
          {stop.company_name && <div style={{ fontWeight: 600 }}>{stop.company_name}</div>}
          <div style={{ color: c.muted }}>{addr || '—'}</div>
          {appt && <div><b>Appt</b> {appt}</div>}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {total && est && <span style={s.chip}>Route {Number(total).toLocaleString('en-US')} mi total</span>}
        <span style={s.chip}>Truck route (HGV)</span>
      </div>
      {locLine && <p data-testid="eta-location-note" style={{ ...s.muted, margin: '0.4rem 0' }}>{locLine}</p>}
      {view?.live && hasStopPin && locating && !fresh && (
        <p role="status" data-testid="eta-locating" style={{ ...s.muted, margin: '0.4rem 0' }}>Finding your location…</p>
      )}
      {view?.live && hasStopPin && !locating && !fix && showLocationButton(perm, prefs) && (
        <button type="button" data-testid="eta-use-location" onClick={() => readLocation()} style={{ ...s.btn, width: '100%', marginBottom: 8 }}>📍 Use my location</button>
      )}
      {errText && !near && <p role="status" data-testid="eta-error" style={{ color: c.warning, fontSize: '0.85rem', margin: '0.3rem 0' }}>{errText}</p>}
      {fresh && !near && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', margin: '0.2rem 0 0.4rem' }}>
          <span data-testid="eta-age" style={{ ...s.muted, fontSize: '0.8rem' }}>{ageText(fresh.at, now)} · location used only while this screen is open, never saved</span>
          <button type="button" data-compact data-testid="eta-refresh" onClick={() => route(true)} disabled={busy} style={{ ...s.btn, flex: '0 0 auto', minHeight: 36, fontSize: '0.85rem' }}>↻ Refresh</button>
        </div>
      )}
      <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{announce}</div>

      {stop && (gm || tp || addr) && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...s.lbl, color: c.muted, marginBottom: 6 }}>Navigate to {STOP_LABEL(stop).toLowerCase()}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tp && <a data-testid="nav-truckerpath" href={tp.href} onClick={openTruckerPath} style={{ ...s.btn, ...s.btnPri }}>🚛 Trucker Path</a>}
            {gm && <a data-testid="nav-google" href={gm} target="_blank" rel="noopener noreferrer" style={s.btn}>Google Maps</a>}
            {am && <a data-testid="nav-apple" href={am} target="_blank" rel="noopener noreferrer" style={s.btn}>Apple Maps</a>}
            {addr && <button type="button" data-testid="nav-copy" onClick={onCopy} style={s.btn}>{copied ? '✓ Copied' : '📋 Copy address'}</button>}
          </div>
          <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{copied ? 'Address copied' : ''}</span>
          {!tp && platform !== 'desktop' && hasStopPin === false && <p style={{ ...s.muted, fontSize: '0.78rem', margin: '0.3rem 0 0' }}>Trucker Path needs the stop’s map location.</p>}
        </div>
      )}
      {audience === 'owner' && <div style={{ marginTop: 10 }}><Link href={`/loads/${load.id}`} style={{ color: c.primary, fontSize: '0.9rem' }}>Open load →</Link></div>}
    </section>
  );
}
