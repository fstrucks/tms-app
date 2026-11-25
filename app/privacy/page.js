import { readFileSync } from 'node:fs';
import path from 'node:path';
import LegalDocument from '../components/LegalDocument';
import { renderLegalMarkdown } from '../lib/legalMarkdown';

export const metadata = {
  title: 'Privacy',
  description: 'Privacy policy for PowerHaul TMS, from Power Strong Solutions LLC.',
};

export default function PrivacyPage() {
  const raw = readFileSync(path.join(process.cwd(), 'content/legal/privacy.md'), 'utf8');
  const doc = renderLegalMarkdown(raw);
  return (
    <LegalDocument
      title="Privacy"
      description="How PowerHaul TMS handles information for Power Strong Solutions LLC."
      updatedLabel={doc.updatedLabel}
      html={doc.html}
    />
  );
}
