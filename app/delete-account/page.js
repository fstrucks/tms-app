import LegalDocument from '../components/LegalDocument';
import { formatUpdated } from '../lib/legalMarkdown';
import {
  COMPANY_ANONYMIZED, COMPANY_KEPT, COMPANY_REMOVED, DELETE_ACCOUNT_PAGE_UPDATED,
  FORMER_MEMBER_LABEL, GRACE_DAYS, MEMBER_ANONYMIZED, MEMBER_KEPT, MEMBER_REMOVED,
  SUPPORT_EMAIL,
} from '../lib/accountDeletion';

export const metadata = {
  title: 'Delete account',
  description: 'How to delete a PowerHaul TMS account, what is removed, and what is kept.',
};

function List({ title, items }) {
  return (
    <section style={{ marginTop: '1.25rem' }}>
      <h2 style={{ fontSize: '1.15rem' }}>{title}</h2>
      <ul style={{ paddingLeft: '1.15rem' }}>
        {items.map((item) => <li key={item} style={{ margin: '0.35rem 0' }}>{item}</li>)}
      </ul>
    </section>
  );
}

export default function DeleteAccountPage() {
  return (
    <LegalDocument
      title="Delete your account"
      description="You can delete a PowerHaul TMS account in the app, or ask us to delete it if you cannot sign in."
      updatedLabel={formatUpdated(DELETE_ACCOUNT_PAGE_UPDATED)}
    >
      <h2 style={{ fontSize: '1.15rem' }}>In the app</h2>
      <ol style={{ paddingLeft: '1.15rem' }}>
        <li style={{ margin: '0.35rem 0' }}>Sign in to PowerHaul TMS.</li>
        <li style={{ margin: '0.35rem 0' }}>Open Settings. Company owners can also open the company profile.</li>
        <li style={{ margin: '0.35rem 0' }}>Go to Danger zone.</li>
        <li style={{ margin: '0.35rem 0' }}>Type DELETE, or type your email address. The button stays off until that matches.</li>
        <li style={{ margin: '0.35rem 0' }}>Confirm. You are signed out when it is accepted.</li>
      </ol>

      <h2 style={{ fontSize: '1.15rem' }}>If you are on a company and you are not the owner</h2>
      <p>Your sign-in is deleted right away when you belong to one company. The company stays. If you belong to more than one company, the app will not delete the account. Email {SUPPORT_EMAIL} and ask support to delete it.</p>
      <List title="Removed" items={MEMBER_REMOVED} />
      <List title="Changed" items={MEMBER_ANONYMIZED} />
      <List title="Kept with the company" items={MEMBER_KEPT} />
      <p>Where a name is still shown for someone who left, it says “{FORMER_MEMBER_LABEL}”.</p>

      <h2 style={{ fontSize: '1.15rem' }}>If you own the company</h2>
      <p>If you delete the company, it is scheduled for deletion {GRACE_DAYS} days after you confirm. Sign in again before that day to cancel, or tap Cancel in Danger zone while you are still signed in.</p>
      <p>Transfer ownership first if other people should keep the company. That option is not in the app yet.</p>
      <p>Other people on the company lose their sign-in when the company is deleted, unless they also belong to another company or own one. They are not emailed.</p>
      <List title="Removed" items={COMPANY_REMOVED} />
      <List title="Changed" items={COMPANY_ANONYMIZED} />
      <List title="Kept" items={COMPANY_KEPT} />
      <p>A company marked as a demo will be deleted right away. There is no {GRACE_DAYS}-day wait, and signing in again does not restore it. The company name does not decide that.</p>
      <p>Some companies can’t be deleted from the app. Contact support at {SUPPORT_EMAIL}.</p>

      <h2 style={{ fontSize: '1.15rem' }}>If you cannot sign in</h2>
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: 'var(--primary)' }}>{SUPPORT_EMAIL}</a> from the address on the account
        and say that you want the account deleted. We will delete it for you.
      </p>
    </LegalDocument>
  );
}
