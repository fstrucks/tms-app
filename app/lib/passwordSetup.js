import { safeNext, DEFAULT_NEXT } from './safeNext.js';

export const MIN_PASSWORD = 8;
export const PASSWORD_PATH = '/account/password';

// Returns an error message, or null when the password + confirmation are acceptable.
export function validatePassword(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 72) return 'Password must be 72 characters or fewer.';
  if (!pw.trim()) return 'Password cannot be only spaces.';
  if (pw !== confirm) return "The two passwords don't match.";
  return null;
}

// Signal: user_metadata.password_set, written by our set-password page in the same updateUser
// call that sets the password. Supabase exposes no "has a password" flag to the client, and
// amr only says how *this* session signed in. Accounts that had a password before this flag
// existed get it backfilled the next time they sign in with that password (login page).
export function hasPassword(user) {
  return !!user && user.user_metadata?.password_set === true;
}

// The OTP types that land on /auth/callback. 'recovery' always goes to the reset form.
export const OTP_TYPES = ['invite', 'magiclink', 'recovery', 'signup', 'email', 'email_change'];
export function otpType(raw) { return OTP_TYPES.includes(raw) ? raw : null; }

// Where /auth/callback sends the user after the session is set.
export function callbackDestination({ type, next, user, session }) {
  const n = safeNext(next);
  if (type === 'recovery') return `${PASSWORD_PATH}?mode=reset&next=${encodeURIComponent(n === PASSWORD_PATH ? DEFAULT_NEXT : n)}`;
  const onPw = n === PASSWORD_PATH || n.startsWith(PASSWORD_PATH + '?') || n.startsWith(PASSWORD_PATH + '#');
  // Invite template links use next=/account/password: that must still open setup mode.
  if (type === 'invite' || !hasPassword(user)) return `${PASSWORD_PATH}?mode=setup&next=${encodeURIComponent(onPw ? DEFAULT_NEXT : n)}`;
  if (onPw) return n;
  return n;
}

// redirectTo for resetPasswordForEmail.
export function recoveryRedirect(origin) {
  return `${origin}/auth/callback?type=recovery&next=${encodeURIComponent(PASSWORD_PATH)}`;
}

// Page mode: ?mode=reset wins; otherwise anyone without password_set is setting one for the first time.
export function pageMode(qMode, user) {
  if (qMode === 'reset') return 'reset';
  if (qMode === 'setup' || !hasPassword(user)) return 'setup';
  return 'change';
}
