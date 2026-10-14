# Supabase Auth settings for password setup / reset (PR feat/password-setup)

Apply in the Supabase dashboard (Marc). The code does not change any settings.

## Authentication → URL Configuration
- **Site URL:** `https://tms-app-two-pi.vercel.app`
- **Redirect URLs (allow-list):**
  - `https://tms-app-two-pi.vercel.app/**`
  - `https://*-fst-tms.vercel.app/**`  (Vercel previews, e.g. tms-app-git-feat-password-setup-fst-tms.vercel.app)
  - `http://localhost:3000/**`  (optional, local dev)

Without the preview entry, emails sent from a preview fall back to the Site URL (prod).

## Authentication → Emails → Templates
Links go straight to `/auth/callback` with a token hash, which works even when the link is
opened in a different browser/device than the one that requested it.

**Invite user** (subject: `You're invited to PowerHaul TMS`):
```html
<h2>You're invited to PowerHaul TMS</h2>
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&next=/account/password">Accept the invite and set your password</a></p>
```

**Reset password** (subject: `Reset your PowerHaul TMS password`):
```html
<h2>Reset your password</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}">Choose a new password</a></p>
<p>If you didn't ask for this, ignore this email.</p>
```
`{{ .RedirectTo }}` is the app's own `redirectTo`
(`<origin>/auth/callback?type=recovery&next=%2Faccount%2Fpassword`), so the link returns to the
same deployment (prod or preview) that sent it. It already contains `?`, hence `&token_hash`.

**Magic link** (optional, recommended for consistency):
```html
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=magiclink">Sign in to PowerHaul TMS</a></p>
```
(The app's magic-link redirectTo is `<origin>/auth/callback?next=...`.)

Leaving the default `{{ .ConfirmationURL }}` templates also works: the callback handles the
`#access_token…&type=recovery|invite` redirect, as long as the redirect URL is allow-listed.

## Does any of this depend on Postmark?
No for the URL config and templates: they are stored in Supabase and used by whichever SMTP sends.
Yes for real-world delivery: Supabase's built-in mailer only sends to project team members and is
limited to a few emails per hour, so invites/resets to testers need the custom SMTP
(smtp.postmarkapp.com:587, noreply@fstrucks.com) and Postmark DKIM/Return-Path DNS verified.
Also: Supabase applies an "Emails per hour" rate limit (Auth → Rate Limits), set to 30.
