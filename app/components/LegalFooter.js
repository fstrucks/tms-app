import Link from 'next/link';

const link = {
  color: 'var(--text-muted)',
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '0 0.15rem',
  textDecoration: 'none',
};

// Small link row. Used on sign-in, first-time password setup, settings, and the public legal pages.
export default function LegalFooter({ includeDelete = false }) {
  return (
    <nav aria-label="Policies" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 1rem', marginTop: '1.5rem', fontSize: '0.875rem' }}>
      <Link href="/privacy" style={link}>Privacy</Link>
      <Link href="/terms" style={link}>Terms</Link>
      {includeDelete && <Link href="/delete-account" style={link}>Delete account</Link>}
    </nav>
  );
}
