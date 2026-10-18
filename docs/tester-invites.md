# Tester invites (owner only)

**Where:** Company profile → "Invite a tester" (owners only) → `/account/invite`.

**Flow**
1. The owner enters an email, an optional name, and an access level (Driver, the default; Dispatcher; or Management. Owner is never offered).
2. `POST /api/account/invites` checks server-side that Supabase Auth vouches for the caller and that the caller owns a `company_profiles` row. Otherwise it returns 401 / 403 / 503.
3. Duplicate check against `auth.admin.listUsers`:
   - An address that is registered or has accepted gets 409 "already has a PowerHaul account".
   - An address with a pending invite gets 409 "already invited … Use Resend".
4. `auth.admin.inviteUserByEmail(email, { redirectTo: <origin>/account/password, data: { full_name } })`. The existing "You're invited to PowerHaul TMS" template and Postmark SMTP send it.
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
