'use client';
// Leaflet map (loaded only through next/dynamic from LoadRouteCard, never on the server).
// OpenStreetMap tile policy: standard tile URL, visible attribution, max zoom 19, no prefetching or bulk download,
// browser caching left alone, referrer sent. Route data © openrouteservice by HeiGIT.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { decodePolyline, PIN_LABEL, fitTarget, FIT_PADDING, boundsWithTruck } from '../lib/loadRoute';

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTRIBUTION = '© <a href="https://openrouteservice.org/" target="_blank" rel="noopener">openrouteservice</a> by HeiGIT | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const pin = (label, color) => L.divIcon({
  className: 'ph-pin',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:${color};color:#fff;font:700 13px system-ui;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${label}</span>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
});

// invalidateSize first (Leaflet measured the container before layout), then frame everything.
export function fitView(m, node, bounds) {
  if (!m || !node || !node.clientWidth || !node.clientHeight) return false;
  m.invalidateSize({ animate: false });
  const b = fitTarget(bounds);
  if (b.kind === 'bounds') m.fitBounds(b.bounds, { padding: FIT_PADDING, maxZoom: 12, animate: false });
  else if (b.kind === 'point') m.setView(b.point, 10, { animate: false });
  else m.setView([39.5, -98.35], 3, { animate: false });
  return true;
}

// Home card Panel 2 adds `truck` ({ lat, lng }: the driver's position, memory only, never stored), `live` (encoded
// polyline from there to the next stop) and `label`. Those layers update in place: no re-fit and no map rebuild, so
// an ETA refresh doesn't pull new tiles. Tiles stay light in dark mode (no filter).
const truckIcon = () => L.divIcon({
  className: 'ph-truck',
  html: '<span style="display:block;width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px rgba(37,99,235,.25)"></span>',
  iconSize: [18, 18], iconAnchor: [9, 9],
});

export default function RouteMap({ stops, geometry, truck = null, live = null, label = null, doneIds = [] }) {
  const el = useRef(null);
  const map = useRef(null);
  const overlay = useRef(null);
  const extra = useRef([]);      // truck dot + live leg, included in the fit (QA #118)
  const truckFitted = useRef(null);
  useEffect(() => {
    if (!el.current) return;
    const touch = L.Browser.mobile || L.Browser.touch;
    // One finger scrolls the page on phones (dragging off); pinch zooms; +/− buttons stay.
    const m = L.map(el.current, { scrollWheelZoom: false, dragging: !touch, zoomControl: true, attributionControl: true });
    m.setView([39.5, -98.35], 3); // valid state until the container is sized and fitView frames the route
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(m);
    const pts = (stops || []).filter((s) => s.lat != null && s.lng != null);
    const bounds = [];
    pts.forEach((s, i) => {
      const lab = PIN_LABEL(s, i, pts.length);
      const done = doneIds.includes(s.id); // PR #115 follow-up: checked-off stops are grey with a check
      const color = done ? '#6b7280' : lab === 'P' ? '#15803d' : lab === 'D' ? '#b91c1c' : '#1d4ed8';
      L.marker([s.lat, s.lng], { icon: pin(done ? '✓' : lab, color), title: `${s.stop_type || 'stop'}${s.city ? `: ${s.city}${s.state ? `, ${s.state}` : ''}` : ''}`, keyboard: false }).addTo(m);
      bounds.push([s.lat, s.lng]);
    });
    const line = decodePolyline(geometry || '');
    if (line.length > 1) { L.polyline(line, { color: '#2563eb', weight: 4, opacity: live ? 0.35 : 0.85 }).addTo(m); bounds.push(...line); }
    // QA #83 r3: fit the route line + all pins with padding only once the container has a real size, and again
    // when its width/height changes (phone rotation, desktop pane). Fitting at 0×0 zoomed in so far pins were off-screen.
    const fit = () => fitView(m, el.current, [...bounds, ...extra.current]);
    m._phFit = fit; truckFitted.current = null;
    let raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(fit) : null;
    if (raf == null) fit();
    let last = '';
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      const w = el.current?.clientWidth || 0, h = el.current?.clientHeight || 0, k = `${w}x${h}`;
      if (!w || !h || k === last) return;
      last = k; fit();
    }) : null;
    ro?.observe(el.current);
    map.current = m;
    return () => { if (raf != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf); ro?.disconnect(); m.remove(); map.current = null; };
  }, [JSON.stringify(stops), geometry, doneIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Truck dot + live leg, redrawn in place on the current map (no fitBounds here).
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!overlay.current || overlay.current._phMap !== m) { overlay.current = L.layerGroup().addTo(m); overlay.current._phMap = m; }
    const g = overlay.current;
    g.clearLayers();
    const leg = decodePolyline(live || '');
    if (leg.length > 1) L.polyline(leg, { color: '#1d4ed8', weight: 5, opacity: 0.95 }).addTo(g);
    const hasTruck = truck && Number.isFinite(truck.lat) && Number.isFinite(truck.lng);
    if (hasTruck) L.marker([truck.lat, truck.lng], { icon: truckIcon(), title: 'You (approximate)', keyboard: false }).addTo(g);
    // QA #118: re-frame once when the truck first shows up on this map so the dot isn't off-screen. Later refreshes
    // don't re-fit (no tile churn); resizes include it. fitView's maxZoom 12 stops a truck sitting on a pin from zooming in too far.
    extra.current = boundsWithTruck([], hasTruck ? truck : null, leg);
    if (hasTruck && truckFitted.current !== m) { truckFitted.current = m; m._phFit?.(); }
  }, [truck?.lat, truck?.lng, live, JSON.stringify(stops), geometry]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (label && el.current) el.current.setAttribute('aria-label', label); }, [label]);

  return <div ref={el} data-testid="route-map" role="img" aria-label="Map of pickup and delivery with the truck route"
    style={{ width: '100%', height: 'clamp(180px, 42vw, 280px)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface-2)', zIndex: 0, position: 'relative' }} />;
}
