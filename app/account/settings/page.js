'use client';
// Account → Settings: per-device preferences. "Auto-start location" (lib/autoLocation): stored only in this browser.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { readAutoLocation, setAutoLocation } from '../../lib/autoLocation';
import DangerZone from '../../components/DangerZone';
import LegalFooter from '../../components/LegalFooter';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', background: 'var(--surface)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.875rem' },
};

export default function SettingsPage() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => { setPrefs(readAutoLocation(window.localStorage)); }, []);
  function toggle(on) { setAutoLocation(window.localStorage, on); setPrefs(readAutoLocation(window.localStorage)); }
  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.5rem' }}>Settings</h1>
      <div style={s.card}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Location</h2>
        {prefs && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, cursor: 'pointer', color: 'var(--text)' }}>
            <input type="checkbox" data-testid="auto-location-toggle" checked={prefs.enabled} onChange={(e) => toggle(e.target.checked)}
              style={{ width: 24, height: 24, accentColor: 'var(--primary)' }} />
            <span style={{ fontWeight: 600 }}>Auto-start location</span>
          </label>
        )}
        <p style={s.muted}>
          When on, the Home map starts your location by itself once you’ve allowed it (no “Use my location” tap).
          Your position is used only while that screen is open and is never saved. This setting is for this device only.
        </p>
        {prefs && !prefs.optedIn && prefs.enabled && <p style={s.muted} data-testid="auto-location-hint">Tap “Use my location” on the Home map once to turn it on.</p>}
        <p style={s.muted}>Your phone may still ask for permission now and then; that’s controlled by the phone, not the app.</p>
      </div>
      <DangerZone />
      <p style={{ marginTop: '1rem' }}><Link href="/" style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Home</Link></p>
      <LegalFooter includeDelete />
    </main>
  );
}
