import Link from 'next/link';
import LegalFooter from './LegalFooter';

const main = { padding: '1rem', fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto', color: 'var(--text)' };

export default function LegalDocument({ title, description, updatedLabel, html, children }) {
  return (
    <main style={main}>
      <p style={{ marginTop: 0 }}>
        <Link href="/" style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>PowerHaul TMS</Link>
      </p>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.35rem' }}>{title}</h1>
      {description && <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{description}</p>}
      {updatedLabel && <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Last updated {updatedLabel}</p>}
      {html != null && <div className="legal-copy" dangerouslySetInnerHTML={{ __html: html }} />}
      {children}
      <LegalFooter includeDelete />
    </main>
  );
}
