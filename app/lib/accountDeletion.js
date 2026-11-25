// Account deletion rules. Pure helpers: no database and no network.
// The database work is public.account_deletion_apply (supabase/migrations/20261028000100_account_deletion.sql).
// The route calls that function only after it has identified the signed-in person from their session.

export const GRACE_DAYS = 14;
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
export const CONFIRM_WORD = 'DELETE';
export const FORMER_MEMBER_LABEL = 'Former team member';
// Change this in one place if the mailbox is different. Needs confirmation before release.
export const SUPPORT_EMAIL = 'support@pwrstrong.net';
// Real owner company. Also honored when company_profiles.deletion_locked is true.
export const PROTECTED_COMPANY_ID = '155fd2a0-11a9-4a3c-8f58-7efab00a188b';
export const DELETE_ACCOUNT_PAGE_UPDATED = '2026-11-25';
export const DOCUMENTS_BUCKET = 'documents';

// Personal files live under {uid}/bug-reports/. Everything else under {uid}/ that is not tied to
// company work (a load, truck, expense, scale ticket, maintenance record, or packet) is also personal
// and is removed with the login. Company files are moved to {owner}/retained/{uid}/... so the company keeps them.
export const PERSONAL_STORAGE_DIRS = ['bug-reports'];

export function confirmationMatches(typed, email) {
  const trimmed = String(typed ?? '').trim();
  if (trimmed === CONFIRM_WORD) return true;
  const em = String(email ?? '').trim().toLowerCase();
  return !!em && trimmed.toLowerCase() === em;
}

export function purgeAfter(requestedAt, days = GRACE_DAYS) {
  const d = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

export function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

// Immediate deletion is only company_profiles.is_demo, set by hand. The company name is not used.
export function isDemoCompany(profile) {
  return profile?.is_demo === true;
}

export function isProtectedCompany(profile) {
  if (!profile) return false;
  return profile.deletion_locked === true || profile.id === PROTECTED_COMPANY_ID;
}

export function protectedCompanyMessage() {
  return `This company can't be deleted from the app. Contact support at ${SUPPORT_EMAIL}.`;
}

export function multiCompanyMessage() {
  return `You belong to more than one company. Email ${SUPPORT_EMAIL} and ask support to delete this account.`;
}

export function deletionKind({ ownsCompany, demo }) {
  if (!ownsCompany) return { kind: 'member', immediate: true, graceDays: 0 };
  if (demo) return { kind: 'company', immediate: true, graceDays: 0, reason: 'demo' };
  return { kind: 'company', immediate: false, graceDays: GRACE_DAYS, reason: 'grace' };
}

// People who also belong to another company, or who own one, keep their sign-in.
// Everyone else on this company loses their sign-in when the company is deleted. We do not email them.
export function memberKeepsLogin({ otherMemberships = 0, ownsOtherCompany = false } = {}) {
  return otherMemberships > 0 || ownsOtherCompany === true;
}

export function shouldCancelOnSignIn({ baselineSignInAt, currentSignInAt } = {}) {
  const base = Date.parse(baselineSignInAt || '');
  const cur = Date.parse(currentSignInAt || '');
  if (!Number.isFinite(base) || !Number.isFinite(cur)) return false;
  return cur > base;
}

export function retainedStoragePath(ownerId, fromPath) {
  const path = String(fromPath || '');
  const slash = path.indexOf('/');
  if (!ownerId || slash <= 0) return null;
  const memberId = path.slice(0, slash);
  const rest = path.slice(slash + 1);
  if (!rest || memberId === ownerId) return path;
  return `${ownerId}/retained/${memberId}/${rest}`;
}

export function classifyMemberObject({ path, uid, keptPaths } = {}) {
  const p = String(path || '');
  const id = String(uid || '');
  if (!p || !id || !p.startsWith(`${id}/`)) return 'ignore';
  const rest = p.slice(id.length + 1);
  const top = rest.split('/')[0];
  if (PERSONAL_STORAGE_DIRS.includes(top)) return 'delete';
  if (keptPaths && keptPaths.has(p)) return 'reassign';
  return 'delete';
}

export const MEMBER_REMOVED = [
  'Your sign-in, password, and sessions on this app',
  'Your personal profile',
  'Your place on the company team, and any invite that was only for you',
  'Bug reports you sent, and the screenshots stored with them',
  'Files that are only yours: bug-report screenshots, and uploads that are not tied to a company load, truck, expense, scale ticket, maintenance record, or packet',
  'Saved fuel-card or ELD column layouts that belong only to you',
];

export const MEMBER_ANONYMIZED = [
  `Your name is taken off company records. Where a name is still shown for someone who left, it says “${FORMER_MEMBER_LABEL}”`,
  'Facility reviews and facility notes you wrote stay in the shared directory. They are no longer tied to your sign-in or to this company. If you tick the box to delete your reviews too, your reviews are deleted instead. Your notes stay',
];

export const MEMBER_KEPT = [
  'Loads, stops, expenses, mileage, invoices, and the other records of the company',
  'Documents you added for a company load, truck, expense, scale ticket, maintenance record, or packet. Those files stay with the company',
  'The driver card the company keeps (the name and license the company entered). Only the link to your sign-in is removed',
  'A load you were assigned to is unassigned. If it was Dispatched and has no driver after that, it goes back to Booked. Other statuses stay as they are',
];

export const COMPANY_REMOVED = [
  'The company profile, trucks, trailers, loads, stops, documents, expenses, mileage, invoices, packets, insurance, and maintenance records',
  'The company’s files',
  'Your sign-in',
  'The sign-in of anyone who belongs only to this company',
  'Invites for this company',
];

export const COMPANY_ANONYMIZED = [
  'Rows that count toward the monthly email limit (load packets, carrier packets, and insurance certificate requests). The count stays. Addresses and message details are removed',
  'Facility reviews and notes from this company stay in the shared directory. They are detached from the company and from the people, with no name attached. If the owner ticks the box to delete reviews too, the reviews are deleted instead. The notes stay',
];

export const COMPANY_KEPT = [
  'The shared list of facilities (names and addresses)',
  'Facility notes, no longer tied to this company. Facility reviews (the stars and the text) too, unless the owner chose to delete them',
  'A person who also belongs to another company, or who owns one, keeps their sign-in. They lose access to this company only',
];

export function ownerWarnings({ companyName, graceDays = GRACE_DAYS, demo = false } = {}) {
  const name = companyName ? `“${companyName}”` : 'this company';
  const wait = demo
    ? `If you delete ${name}, it is marked as a demo, so it will be deleted right away. There is no waiting period and signing in again will not bring it back.`
    : `If you delete ${name}, it is scheduled for deletion ${graceDays} days after you confirm. Sign in again before that day to cancel, or tap Cancel here while you are still signed in.`;
  return [
    wait,
    'This removes the company and its loads, documents, expenses, mileage, trucks, invoices, and packets.',
    'Facilities stay in the shared directory. Facility reviews stay too, no longer tied to this company or to you, unless you tick the box below to delete them. Facility notes always stay, with no name attached.',
    'Monthly email counts are kept so the limit does not reset. Addresses on those sends are removed.',
    'Other people on this company lose their sign-in when the company is deleted, unless they also belong to another company or own one. They are not emailed.',
    'Transfer ownership first if others should keep the company. Transferring ownership is not available in the app yet.',
  ];
}

export function memberWarnings() {
  return [
    'This deletes your sign-in and your personal profile. It does not delete the company.',
    'Loads, expenses, mileage, and documents you added for the company stay with the company.',
    `Your name is removed. Where a name is still shown, it says “${FORMER_MEMBER_LABEL}”.`,
    'If you are assigned to a dispatched load, that load goes back to Booked when the driver is cleared.',
    'Facility reviews you wrote stay, without your name, unless you tick the box below to delete them. Facility notes you wrote stay, without your name.',
    'Bug-report screenshots and other files that are only yours are deleted.',
  ];
}

// Approved by Marc (Nov 25): the optional "delete my reviews too" box (unticked by default). Reviews only; notes stay.
export const DELETE_REVIEWS_CHOICE = {
  member: {
    label: 'Also delete the facility reviews I wrote',
    hint: 'Leave this off to keep them in the shared facility directory without your name. If you tick it, they are deleted for good and facility ratings update. Facility notes you wrote stay either way, without your name.',
    confirm: 'Your facility reviews will be deleted too.',
  },
  owner: {
    label: 'Also delete facility reviews from this company',
    hint: 'This covers reviews written for this company by anyone on it, and every review written by you or by teammates who lose their sign-in. Leave this off to keep them in the shared directory with no name attached. Facility notes stay either way, with no name attached.',
    confirm: 'Facility reviews from this company will be deleted too.',
  },
};
export const DELETE_REVIEWS_PAGE_STEP = 'Optional: tick the box to also delete your facility reviews (for a company owner, the reviews from the company). Leave it off to keep them without a name. Facility notes stay either way, without a name.';

export function scheduledMessage({ purgeAt, companyName } = {}) {
  const when = formatWhen(purgeAt);
  const name = companyName ? `“${companyName}”` : 'Your company';
  return `${name} is scheduled to be deleted on ${when}. You are signed out now. Sign in again before that date to cancel.`;
}

export function cancelledMessage() {
  return 'Company deletion was cancelled because you signed in.';
}

export function cronAuthorized(headerValue, altHeader, env = {}) {
  const secret = String(env.CRON_SECRET || env.ACCOUNT_DELETION_CRON_SECRET || '');
  if (!secret) return false;
  const bearer = String(headerValue || '').replace(/^Bearer\s+/i, '');
  const alt = String(altHeader || '');
  return safeEqual(bearer, secret) || safeEqual(alt, secret);
}

function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
