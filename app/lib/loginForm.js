// Sign-in form helpers. Password managers / browser autofill (and some pastes) fill the inputs without React
// seeing an onChange, so the old "disabled until both are typed" button stayed grey. Now the button is only
// disabled while signing in, and the values are read from the form itself at submit time.

// Current values: the DOM inputs win (autofill), React state is the fallback (tests / no form element).
export function readCredentials(form, state = {}) {
  const el = (name) => form?.elements?.namedItem?.(name) || form?.elements?.[name] || null;
  const val = (name) => { const e = el(name); return e && typeof e.value === 'string' ? e.value : null; };
  return { email: String(val('email') ?? state.email ?? '').trim(), password: String(val('password') ?? state.password ?? '') };
}
// → error text, or null when the form can be sent.
export function validateCredentials({ email, password }, usePw = true) {
  if (!email) return usePw && !password ? 'Enter your email and password.' : 'Enter your email.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email address.';
  if (usePw && !password) return 'Enter your password.';
  return null;
}
export const submitDisabled = (sending) => !!sending;
