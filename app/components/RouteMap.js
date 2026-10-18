'use client';
// Leaflet map (loaded only through next/dynamic from LoadRouteCard, never on the server).
// OpenStreetMap tile policy: standard tile URL, visible attribution, max zoom 19, no prefetching or bulk download,
// browser caching left alone, referrer sent. Route data © openrouteservice by HeiGIT.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { decodePolyline, PIN_LABEL } from '../lib/loadRoute';

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTRIBUTION = '© <a href="https://openrouteservice.org/" target="_blank" rel="noopener">openrouteservice</a> by HeiGIT | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const pin = (label, color) => L.divIcon({
  className: 'ph-pin',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:${color};color:#fff;font:700 13px system-ui;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${label}</span>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
});

export default function RouteMap({ stops, geometry }) {
  const el = useRef(null);
  const map = useRef(null);
  useEffect(() => {
    if (!el.current) return;
    const touch = L.Browser.mobile || L.Browser.touch;
    // One finger scrolls the page on phones (dragging off); pinch zooms; +/− buttons stay.
    const m = L.map(el.current, { scrollWheelZoom: false, dragging: !touch, zoomControl: true, attributionControl: true });
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(m);
    const pts = (stops || []).filter((s) => s.lat != null && s.lng != null);
    const bounds = [];
    pts.forEach((s, i) => {
      const lab = PIN_LABEL(s, i, pts.length);
      const color = lab === 'P' ? '#15803d' : lab === 'D' ? '#b91c1c' : '#1d4ed8';
      L.marker([s.lat, s.lng], { icon: pin(lab, color), title: `${s.stop_type || 'stop'}${s.city ? `: ${s.city}${s.state ? `, ${s.state}` : ''}` : ''}`, keyboard: false }).addTo(m);
      bounds.push([s.lat, s.lng]);
    });
    const line = decodePolyline(geometry || '');
    if (line.length > 1) { L.polyline(line, { color: '#2563eb', weight: 4, opacity: 0.85 }).addTo(m); bounds.push(...line); }
    if (bounds.length > 1) m.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
    else if (bounds.length === 1) m.setView(bounds[0], 10);
    else m.setView([39.5, -98.35], 3);
    map.current = m;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => m.invalidateSize()) : null;
    ro?.observe(el.current);
    return () => { ro?.disconnect(); m.remove(); map.current = null; };
  }, [JSON.stringify(stops), geometry]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} data-testid="route-map" role="img" aria-label="Map of pickup and delivery with the truck route"
    style={{ width: '100%', height: 'clamp(180px, 42vw, 280px)', borderRadius: 10, overflow: 'hidden', background: '#e5e7eb', zIndex: 0, position: 'relative' }} />;
}
