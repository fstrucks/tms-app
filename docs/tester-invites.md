# Tester invites (owner only)

**Where:** Company profile → "Invite a tester" (owners only) → `/account/invite`.

**Flow**
1. The owner enters an email, an optional name, and an access level (Driver, the default; Dispatcher; or Management. Owner is never offered).
2. `POST /api/account/invites` checks server-side that Supabase Auth vouches for the caller and that the caller owns a `company_profiles` row. Otherwise it returns 401 / 403 / 503.
3. Duplicate check against `auth.admin.listUsers`:
   - An address that is registered or has accepted gets 409 "already has a PowerHaul account".
   - An address with a pending invite gets 409 "already invited … Use Resend".
4. `auth.admin.inviteUserByEmail(email, { redirectTo: <origin>/account/password, data: { full_name } })`. The existing "You're invited to PowerHaul TMS" template and Postmark SMTP send it, from the Supabase SMTP sender (noreply@pwrstrong.net once pwrstrong.net is verified in Postmark; see docs/supabase-auth-password-setup.md).
5. `auth.admin.updateUserById(id, { app_metadata: { tester_invite: { by, company, role, log } } })`. This is the trusted record. Only the service role can write `app_metadata`.
6. A `company_members` row `(profile_id = owner's company, user_id, role)` is inserted with the service role (idempotent, and it never changes an existing member's role). That's what `packet_role` / `company_role` already use, so the tester sees the company's packets, company profile and Truck tab once they accept. Loads, documents, expenses and mileage stay per-user under the existing RLS, so a tester starts with their own empty lists.

**List:** company members (minus the owner) plus users whose `app_metadata.tester_invite.company` is this company.
- **Pending:** `invited_at` set and no `email_confirmed_at` / `last_sign_in_at`.
- **Accepted:** otherwise.

Pending rows have a Resend button. An accepted row that isn't linked has a Link button, which links without sending an email.

**Limits:**
- **Per owner:** 10 invites + resends per rolling hour, counted from `tester_invite.log`.
- **Per address:** a 2-minute cooldown.
- **Supabase:** its own "Emails per hour" limit (30) still applies.
- **Postmark:** the free plan allows 100 emails/month.

**No SQL:** uses existing `company_members`, `company_profiles` and auth metadata only. The existing `on_auth_user_created` trigger already creates the `profiles` row for invited users.

**No domain limit:** any address can be invited. `PACKET_SEND_ALLOWED_DOMAINS` only applies to packet emails.

**Cancel (pending only).** The owner presses Cancel, then confirms with "Yes, cancel". The server re-reads the user from the admin API and refuses (logging the reason) unless all of these hold:
1. **Still pending:** `invited_at` is set and there's no `email_confirmed_at` / `confirmed_at` / `last_sign_in_at`.
2. **This company's invite:** `app_metadata.tester_invite.company` is this company. *Invites made before this PR* have no record. They're allowed only if a `company_members` row for this company exists. A record naming another company always refuses, and `user_metadata` is never trusted.
3. **Nothing else to lose:** no membership in any other company, and they don't own a company profile.

If all three hold, the server deletes this company's `company_members` row, then calls `auth.admin.deleteUser`. If the delete fails, the user is told it was partial and can retry.

**Menu:** an owner-only "Invite testers" item in the account menu (`InviteTestersMenuItem`, owner = owns a `company_profiles` row, via an RLS-scoped read). Arrow-key navigation now follows DOM order, so optional items are included.

## Proposed invite email (draft, NOT applied to Supabase)
Supabase → Authentication → Emails → **Invite user**. The app now passes `company_name` (the company's legal name) and `inviter_name` (the owner's profile name, if set) in the invite's user data, so the template can read `{{ .Data.company_name }}` / `{{ .Data.inviter_name }}`. Fallbacks cover invites that don't carry them.

**Subject**
```
{{ if .Data.inviter_name }}{{ .Data.inviter_name }}{{ else }}Marc Brooks{{ end }} invited you to PowerHaul TMS
```

**Body (HTML)**
```html
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="margin:0 0 12px">You're invited to PowerHaul TMS</h2>
  <p style="margin:0 0 12px">{{ if .Data.inviter_name }}{{ .Data.inviter_name }}{{ else }}Marc Brooks{{ end }} invited you to join
    <strong>{{ if .Data.company_name }}{{ .Data.company_name }}{{ else }}our team{{ end }}</strong> on PowerHaul TMS,
    the app we use for loads, documents, expenses and carrier packets.</p>
  <p style="margin:0 0 20px">Set a password to finish creating your account.</p>
  <p style="margin:0 0 24px">
    <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">Set your password</a>
  </p>
  <p style="margin:0 0 8px;font-size:14px;color:#4b5563">Button not working? Copy this link into your browser:</p>
  <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="{{ .ConfirmationURL }}" style="color:#2563eb">{{ .ConfirmationURL }}</a></p>
  <p style="margin:0;font-size:13px;color:#6b7280">This is a test version of PowerHaul TMS. Please use made-up data only.
    If you weren't expecting this invite, you can ignore this email.</p>
</div>
```

**Plain-text fallback** (if the sender adds a text part; Supabase sends the HTML template):
```
You're invited to PowerHaul TMS

{{ if .Data.inviter_name }}{{ .Data.inviter_name }}{{ else }}Marc Brooks{{ end }} invited you to join {{ if .Data.company_name }}{{ .Data.company_name }}{{ else }}our team{{ end }} on PowerHaul TMS.

Set your password: {{ .ConfirmationURL }}

This is a test version. Please use made-up data only. If you weren't expecting this invite, ignore this email.
```

Notes:
- `{{ .ConfirmationURL }}` uses Supabase's verify link, which then redirects to the `redirectTo` we pass (`<site>/account/password`) when it's allow-listed. The current template's `/auth/callback?token_hash=…&type=invite&next=/account/password` link also works. Either way the callback handles it.
- **Accept link goes to prod even from a preview:** the current template builds the link from `{{ .SiteURL }}` (prod), so an invite sent from a preview lands on prod's `/account/password`. That's fine for now: it's the same Supabase project, and the account works on every deployment. With `{{ .ConfirmationURL }}`, the link follows `redirectTo` (the deployment that sent it) once that URL is allow-listed.
