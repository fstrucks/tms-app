import { signInHref, SITE_CONTACT_EMAIL } from '../lib/siteHost';

const TITLE = 'PowerHaul TMS by Power Strong Solutions LLC';
const DESC = 'PowerHaul TMS: trucking software for owner-operators.';

export const metadata = {
  title: { absolute: TITLE },
  description: DESC,
  robots: { index: true, follow: true },
  alternates: { canonical: 'https://pwrstrong.net/' },
  openGraph: { title: TITLE, description: DESC, url: 'https://pwrstrong.net/', siteName: 'PowerHaul TMS', type: 'website' },
};

const FEATURES = [
  ['Load management', 'Keep each load’s stops, times, broker and documents in one place.'],
  ['Rate confirmation scanning', 'Scan or upload a rate con and the load details are filled in for you to check.'],
  ['Invoicing and packet export', 'Build the invoice and send one PDF packet with the rate con, BOL and POD.'],
  ['Mileage and maintenance tracking', 'Log miles by state and keep track of service on your truck.'],
];

const s = {
  main: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', color: 'var(--text)', padding: '2.5rem var(--gutter) 1.5rem', maxWidth: 1000, margin: '0 auto', lineHeight: 1.5 },
  company: { margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.02em' },
  h1: { margin: '0.25rem 0 0.5rem', fontSize: 'clamp(2rem, 6vw, 2.75rem)', lineHeight: 1.15 },
  lead: { margin: '0 0 1.5rem', fontSize: '1.2rem', color: 'var(--text-muted)' },
  cta: { display: 'inline-block', padding: '0.8rem 1.4rem', borderRadius: 12, background: 'var(--primary)', color: 'var(--on-primary)', textDecoration: 'none', fontWeight: 600, fontSize: '1.05rem' },
  h2: { fontSize: '1.25rem', margin: '2.5rem 0 0.75rem' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.9rem 1rem' },
  link: { color: 'var(--primary)' },
  footer: { borderTop: '1px solid var(--divider)', marginTop: '3rem', paddingTop: '1.25rem', fontSize: '0.9rem', color: 'var(--text-muted)' },
  nav: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem', marginBottom: '0.75rem' },
};

// The app shell (nav bar) is hidden here; AppNav also skips /site. The :has rule covers the
// pwrstrong.net "/" rewrite, where the browser path is "/".
const HIDE_SHELL = 'body:has(.pwr-site) .appnav-top, body:has(.pwr-site) .appnav-mtop, body:has(.pwr-site) .appnav-bottom { display: none !important; } body:has(.pwr-site) { padding-bottom: 0 !important; }'
  + ' .pwr-hero { display: grid; gap: 1.5rem; align-items: center; }'
  + ' .pwr-hero svg { width: 100%; max-width: 380px; height: auto; justify-self: center; }'
  + ' .pwr-features { display: grid; gap: 0.75rem; grid-template-columns: 1fr; }'
  + ' @media (min-width: 768px) { .pwr-hero { grid-template-columns: 1.2fr 1fr; } .pwr-features { grid-template-columns: 1fr 1fr; } }';

export default function SitePage() {
  return (
    <main className="pwr-site" style={s.main}>
      <style dangerouslySetInnerHTML={{ __html: HIDE_SHELL }} />
      <header className="pwr-hero">
        <div>
        <p style={s.company}>Power Strong Solutions LLC</p>
        <h1 style={s.h1}>PowerHaul TMS</h1>
        <p style={s.lead}>Trucking software for owner-operators.</p>
        <a href={signInHref()} style={s.cta}>Sign in</a>
        </div>
        <Truck />
      </header>
      <section aria-labelledby="features">
        <h2 id="features" style={s.h2}>What it does</h2>
        <ul className="pwr-features" style={s.list}>
          {FEATURES.map(([t, d]) => (
            <li key={t} style={s.item}><strong>{t}</strong><br />{d}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="contact">
        <h2 id="contact" style={s.h2}>Contact</h2>
        <p style={{ margin: 0 }}>Email <a href={`mailto:${SITE_CONTACT_EMAIL}`} style={s.link}>{SITE_CONTACT_EMAIL}</a></p>
      </section>
      <footer style={s.footer}>
        <nav aria-label="Legal" style={s.nav}>
          <a href="/privacy" style={s.link}>Privacy Policy</a>
          <a href="/terms" style={s.link}>Terms of Service</a>
          <a href="/delete-account" style={s.link}>Delete your account</a>
        </nav>
        <address style={{ fontStyle: 'normal' }}>Power Strong Solutions LLC<br />30 N Gould St #66595<br />Sheridan, WY 82801</address>
        <p style={{ margin: '0.75rem 0 0' }}>© 2026 Power Strong Solutions LLC</p>
      </footer>
    </main>
  );
}

// Simple decorative truck drawn with the app's colour variables (no external images).
function Truck() {
  return (
    <svg viewBox="0 0 320 170" aria-hidden="true" focusable="false">
      <rect x="0" y="150" width="320" height="4" rx="2" fill="var(--divider)" />
      <rect x="10" y="40" width="190" height="95" rx="8" fill="var(--primary)" />
      <rect x="30" y="62" width="150" height="10" rx="5" fill="var(--on-primary)" opacity="0.35" />
      <rect x="30" y="84" width="110" height="10" rx="5" fill="var(--on-primary)" opacity="0.35" />
      <path d="M205 70 h55 l40 35 v30 h-95 z" fill="var(--primary-soft)" />
      <path d="M220 80 h35 l25 22 h-60 z" fill="var(--bg)" opacity="0.8" />
      {[50, 150, 265].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="140" r="16" fill="var(--text)" />
          <circle cx={cx} cy="140" r="6" fill="var(--bg)" />
        </g>
      ))}
    </svg>
  );
}
