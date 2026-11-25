import { readFileSync } from 'node:fs';
import path from 'node:path';
import LegalDocument from '../components/LegalDocument';
import { renderLegalMarkdown } from '../lib/legalMarkdown';

export const metadata = {
  title: 'Terms',
  description: 'Terms of use for PowerHaul TMS, from Power Strong Solutions LLC.',
};

export default function TermsPage() {
  const raw = readFileSync(path.join(process.cwd(), 'content/legal/terms.md'), 'utf8');
  const doc = renderLegalMarkdown(raw);
  return (
    <LegalDocument
      title="Terms"
      description="Terms of use for PowerHaul TMS, from Power Strong Solutions LLC."
      updatedLabel={doc.updatedLabel}
      html={doc.html}
    />
  );
}
