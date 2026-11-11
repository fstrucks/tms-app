# Rate con email-in (draft PR)

Users forward rate con PDFs to a private address: `ratecon+<32-hex token>@in.fstrucks.com`.

**Moving to in.pwrstrong.net.** Only the token is stored, so the same address works on either domain. The webhook accepts
`ratecon+…@` and `packets@` on both `in.fstrucks.com` and `in.pwrstrong.net` (`INBOUND_DOMAINS` in `app/lib/rateconDrafts.js`).
The app shows in.fstrucks.com until `NEXT_PUBLIC_INBOUND_DOMAIN=in.pwrstrong.net` is set in Vercel. Set it (and redeploy) only after:
1. DNS: MX on the `in.pwrstrong.net` subdomain only → `inbound.postmarkapp.com`, priority 10. The apex pwrstrong.net MX is not touched.
2. Postmark: an inbound stream has a single Inbound domain. Add a second server's inbound stream with Inbound domain
   `in.pwrstrong.net`, the same webhook URL and the same Basic auth; leave the in.fstrucks.com stream as is.
3. A test email to `ratecon+<token>@in.pwrstrong.net` shows up on Documents.
Keep in.fstrucks.com (MX and stream) working until users have switched; old addresses keep working the whole time.

- Route: the existing Postmark webhook `POST /api/inbound/postmark` (same Basic auth). Any `ratecon@` / `ratecon+…@in.fstrucks.com`
  recipient goes to `app/lib/rateconEmail.js`; everything else (e.g. `packets@`) stays on the packet path unchanged.
- Token → user via `ratecon_owner_for_token` (service role only). Unknown/rotated token or a sender not on the optional allowlist:
  logged in `inbound_emails` as `unmatched` with no owner and no files, 200, no bounce.
- Dedupe: `inbound_emails (provider, message_id)` unique, with `message_id = 'ratecon:' || Postmark MessageID`.
- Each PDF (≤10 MB, ≤10 per email, `%PDF-` magic checked) → `documents` row (`doc_type = rate_confirmation`, `source = email`,
  `extraction_status = pending`) at `{user_id}/ratecons/email-…`. The existing rate con reader (moved to `app/lib/rateconExtract.js`,
  unchanged) runs after the 200 via `waitUntil`, using the same `claim_extraction_slot` quota.
- Review: Documents shows a "From email" badge. Read OK → existing Summary + **Create load** (`create_load_from_document`, unchanged).
  Read failed → "Needs manual entry" with the PDF kept, Run extraction (retry) and "Enter load by hand". No load is ever created automatically.
- Skipped attachments (non-PDF, oversize, >10) are listed on Documents for 7 days.
- Address card on Documents: Copy, New address (rotates the token), optional allowed senders (emails or `@domain`, max 20).
  Loads shows a banner when email drafts are waiting.

## Setup (Dakota, after Marc approves; nothing done in this PR)
1. Apply `supabase/migrations/20261019000200_ratecon_email_in.sql` (additive).
2. Postmark: confirm the inbound stream's **Inbound domain** is `in.fstrucks.com` (domain-wide forwarding) and the webhook is
   `https://<prod>/api/inbound/postmark` with the existing Basic auth. If so, `ratecon+…@in.fstrucks.com` already reaches the webhook: **no Postmark or DNS change**.
   If the stream only has the default `…@inbound.postmarkapp.com` address (no inbound domain set), set Inbound domain = `in.fstrucks.com` (MX for `in.fstrucks.com` → `inbound.postmarkapp.com`, priority 10, already planned for packets).
3. Optional: in Postmark's inbound settings, make sure "Include raw email content" is off (not needed).
