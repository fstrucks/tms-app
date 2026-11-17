'use client';
// Company-only map of live shared positions for dispatch / owner / management. Polls; no Realtime.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const truckIcon = () => L.divIcon({
  className: 'ph-office-truck',
  html: '<span class="ph-office-truck-dot"></span>',
  iconSize: [16, 16], iconAnchor: [8, 8],
});

export default function OfficeLocationMap({ points = [] }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return undefined;
    const m = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m);
    layerRef.current = L.layerGroup().addTo(m);
    mapRef.current = m;
    m.setView([39.5, -98.35], 4);
    const ro = new ResizeObserver(() => m.invalidateSize({ animate: false }));
    ro.observe(ref.current);
    return () => { ro.disconnect(); m.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const m = mapRef.current, layer = layerRef.current;
    if (!m || !layer) return;
    layer.clearLayers();
    const withPos = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const latlngs = [];
    for (const p of withPos) {
      const ll = [p.lat, p.lng];
      latlngs.push(ll);
      const mk = L.marker(ll, { icon: truckIcon(), keyboard: true, title: p.label || 'Driver' });
      mk.bindPopup(`<strong>${escapeHtml(p.label || 'Driver')}</strong><br>${escapeHtml(p.load_ref || 'No load')}<br>${escapeHtml(p.age || '')}`);
      layer.addLayer(mk);
    }
    m.invalidateSize({ animate: false });
    if (latlngs.length === 1) m.setView(latlngs[0], 10, { animate: false });
    else if (latlngs.length > 1) m.fitBounds(latlngs, { padding: [28, 28], maxZoom: 12, animate: false });
  }, [points]);

  return <div ref={ref} data-testid="office-location-map" style={{ height: 240, width: '100%', borderRadius: 10, border: '1px solid var(--border)', zIndex: 0 }} />;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
