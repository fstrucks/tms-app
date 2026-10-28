// Public pages that must stay reachable with no sign-in. App Store and Play policies link here.
// There is no auth middleware; these prefixes are also skipped by the welcome sheet, the bug button,
// and the main nav so a signed-out visitor is not sent through the signed-in shell.

// /export is the no-sign-in company export download page (link emailed to the owner).
export const PUBLIC_LEGAL_PATHS = ['/privacy', '/terms', '/delete-account', '/export'];

export function isPublicLegalPath(pathname = '') {
  const p = String(pathname || '');
  return PUBLIC_LEGAL_PATHS.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}
