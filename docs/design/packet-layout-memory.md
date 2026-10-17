# Remember each broker's packet layout (carrier packet G)

Status: **wired in (draft PR #68, do-not-merge).** Marc approved the SQL; Dakota is applying
`supabase/migrations/20261017001900_packet_layouts.sql`. Until it's applied, everything falls back to normal detection
(logged as `[packets] layouts unavailable … apply 20261017001900_packet_layouts.sql`), and no route returns a 500 for it.

### What's built (and choices made while wiring)
- `lib/packetLayouts.js` (server I/O + fallback), `lib/packetLayoutApply.js` (pure: layout → rows, rows → layout fields, diff,
  learn plan), `lib/packetLayoutBanner.js` (client-safe banner text), `app/api/packets/[id]/layout/route.js` (GET state; POST dismiss/apply).
- **Processing** (`packetProcess.js`): after `extractPdf`, fingerprint + broker MC are stored on the packet and the best layout is picked.
  Apply → `source='layout'` rows on matched pages, detection + AI naming only on the other pages. Suggest/changed → `layout_id`
  and `layout_score` only. If placing fails (for example the `source` check isn't widened yet), every page is detected as usual.
- **Inbound**: the forwarded `From:` (then Reply-To, then From when it isn't ours) is saved to `packets.broker_email` in a separate
  update, so a missing column never blocks the packet. The body is read in memory only and never stored.
- **Learning** happens on a successful `/fill`, after the response (`waitUntil`). The target is the active layout for **this packet's**
  `layout_key`, so a fuzzy-applied packet (the broker changed the form) starts its own group and the old group stays active. Fields are
  a whitelist copy (`page, kind, label, box, dpi, page_w, page_h, profile_key`), with `custom:` and `skip` names kept. Scanned packets
  are never learned in v1, because they can't reach the suggest band anyway. A packet processed before the migration gets its
  fingerprint at fill time.
- `last_used_at` is updated when a layout is learned or confirmed on fill, not when it's applied, so the banner's "last used" shows the
  previous real use instead of today. `use_count` is incremented on apply.
- "Changed form" isn't stored as its own column. The GET route re-scores the packet against `layout_id` to show the
  "looks different" banner.
## Goal
When a broker we've seen before sends a carrier packet, put the fields where the user placed them last time
(same names, same boxes). The user only reviews them, so detection and OpenAI naming are skipped for the pages
that match. Values never come from the layout. They're filled from the company profile at render time, as they are today.

## How things work today
- Packets come in two ways. **Email-in** goes through `app/api/inbound/postmark/route.js` + `lib/postmarkInbound.js`.
  The sender is matched to *our* user (`packet_owner_for_email`), so `from_email` is normally Marc or a dispatcher
  **forwarding** the broker's email, not the broker. **Upload** has no email at all.
- `lib/packetProcess.js` claims the packet, then runs `extractPdf` (`lib/packetPdfText.js`: per-page words, lines,
  squares, size, at 200 dpi), then `detectPacket` (`lib/packetDetect.js`), then naming (`lib/packetReader.js`, gpt-4.1-mini, labels
  only), and writes the rows to `packet_fields` (`box` in raster px at 200 dpi, plus `page_w`/`page_h`, `profile_key`, and `source` of local or model).
  A re-run deletes only `local`/`model` rows. `user` rows are kept.
- The mapper (`app/packets/PacketMapper.js` + `lib/packetMapperModel.js`) edits through `PATCH /api/packets/[id]/fields`.
  Editors are owner, dispatcher and management. Drivers can only view.
- `packets.broker_name` exists but nothing fills it yet.

## 1. Matching a repeat packet
Two kinds of signal: **what form is this** (fingerprint) and **who sent it** (broker identity).
A layout is never applied on broker identity alone, because a broker's packet can change. The fingerprint is always required.

### Fingerprint (computed in processPacket from the `extractPdf` output we already have; no new rendering)
For each page:
- `w`, `h`: page size in points, rounded to 1 pt.
- `text_hash`: sha256 (first 16 hex) of the page text, normalized as lowercase, digits removed, punctuation and whitespace
  collapsed. Removing digits means dates, load numbers, and broker-prefilled values don't change the hash.
- `simhash`: 64-bit simhash of the normalized word 3-grams, for fuzzy matching when a broker tweaks a line or two.
- `has_text`: false for scanned pages.

`layout_key` = sha256 of the ordered `text_hash` list. This gives an exact-match lookup through a btree index.

### Broker identity
- **MC number in the packet text**: `MC[#:\s-]*0*(\d{4,8})` on page text. Our own MC from `company_profiles.mc_number`
  is excluded, because packets often print the carrier's MC in a field. If several are found, use the most frequent.
- **Broker email domain**: for email-in, parse the forwarded `From:` line out of `TextBody` (Gmail/Outlook forward
  formats) and fall back to `Reply-To`/`From` only if that sender is not one of our users. Free-mail domains (gmail, yahoo,
  outlook, …) and our own domain are ignored for matching, and the full address is still kept on the packet.
  Uploads have no domain.
- **broker_name**: set when the user saves a layout. It's display only and isn't used for matching.

### Score (candidates are the company's active layouts with page_count within ±2, plus any sharing MC/domain)
| Signal | Points |
|---|---|
| `layout_key` exact (every page text hash equal) | +60 |
| Fuzzy: share of template pages with a packet page at simhash Hamming distance ≤ 6 | up to +40 |
| Page count and all sizes equal | +10 |
| MC equal | +25 |
| MC both present and **different** | −40 (veto auto-apply) |
| Email domain equal | +15 |
| Domain both present and different | −10 |

Thresholds:
- **≥ 70: auto-apply.**
- **45–69: suggest only.** The banner reads "This looks like TQL's packet. Use the saved layout?" and the user taps to apply.
- **< 45: nothing.** Detection runs as it does today.

Fallback order, best first:
1. Exact `layout_key` with no MC conflict. Apply.
2. MC match plus fuzzy fingerprint ≥ 0.8. Apply.
3. Domain match plus fuzzy ≥ 0.8. Apply.
4. Fuzzy alone ≥ 0.9. Suggest only.
5. MC/domain match but fingerprint < 0.5: **the broker's form changed.** Run detection fresh and show "TQL's packet looks
   different from last time, so fields were found fresh."
6. Scanned packets (`has_text` false): only page count, sizes and domain are available, so **suggest only, never
   auto-apply.** Scans shift and skew, so automatic placement there is a v2 item (anchor alignment on a rendered thumbnail).

Packets that bundle several documents are matched **per page**. Template pages are mapped to packet pages by `text_hash`, then by
simhash, so an extra W-9 page or a reordered page still gets the right fields. Pages with no match go through normal detection.
If the page size differs slightly, boxes are scaled by `page_w`/`page_h`.

## 2. What's stored
`packet_layouts`: one row per **version** of a broker form, per company. Rows are immutable. An edit inserts version n+1
and marks the old row `superseded`, which gives history and rollback. Each column:
- `owner_id` (company scope, same as packets; `company_id` is reserved for #27)
- `layout_key` and `version`
- `status`: active, superseded or retired
- `broker_name`, `broker_mc`, `broker_domain`
- `page_count` and `fingerprint` (jsonb, shape above)
- `fields` (jsonb). Each field holds `page, kind, label, box, dpi, page_w, page_h, profile_key`, with at most 400 fields.
  **It never holds values, ciphertext, last4, signature paths or signer names.**
- `source_packet_id`, `created_by`, `use_count`, `last_used_at`, and timestamps.

`packets` gets these new nullable columns: `fingerprint`, `broker_mc`, `broker_email`, `layout_id`, `layout_score`,
`layout_applied_at` and `layout_dismissed_at`. `packet_fields.source` gets a new value, `'layout'`.

## 3. How it's applied
- **On processing**, `processPacket` runs `extractPdf`, then computes the fingerprint and broker identity, then calls `findLayout`.
  - **Auto-apply:** insert `packet_fields` rows from the template with `source='layout'`, `confidence=1` and
    `needs_confirm` for bank keys (the user still confirms bank numbers on every packet). Then set `layout_id`, `layout_score`
    and `layout_applied_at` and bump `use_count`/`last_used_at`. Detection and OpenAI naming run only on unmatched pages.
  - **Suggest:** store `layout_id` and `layout_score` without `layout_applied_at`. Detection runs as normal, and the banner offers the layout.
- **Banner** in the mapper (editors): "Layout from **TQL**, last used Oct 12. 14 fields placed. Review them before filling."
  It has a **Don't use this layout** button. Drivers see a view-only version with no button.
- **Drop it:** `POST /api/packets/[id]/layout { action: 'dismiss' }` deletes the `layout` rows, sets
  `layout_dismissed_at`, and re-runs detection with force. `user` rows are kept. The template isn't changed.
- **Learn and update the template:** this happens when an editor **fills** the packet (`/fill` succeeds). That's the point where the
  layout has been reviewed, so a half-finished edit is never learned. Rules:
  - No layout yet: create version 1, asking for `broker_name` (pre-filled from the MC lookup or domain) in the fill sheet.
  - The applied layout's fields changed (box moved more than 4 px, name changed, field added or removed): insert version n+1 and
    supersede n.
  - No changes: only `last_used_at`.
  - The fingerprint differs from the applied layout (broker changed forms): create a **new** `layout_key` group. The old
    group stays active for older copies of the form. Unused layouts are never deleted automatically; a later settings screen can retire them.
- **Re-run detection** (force) deletes `local`, `model` **and `layout`** rows. Then the layout is re-applied unless it was dismissed.

## 4. Who can see it
Scope is the company, through `public.packet_role(owner_id)`, the same helper packets and packet_sends use. It moves to
`company_id` with #27 without policy changes.
- RLS `select`: any member of the company. The table holds positions and names only.
- No client insert/update/delete policies. Writes go through server routes with the service role after `packetAccess`
  checks the editor role (owner, dispatcher or management). Drivers never create or change layouts.
- No sharing between companies. One carrier's layouts are never offered to another carrier, even for the same broker.

## 5. SQL needed (yes)
`20261017001900_packet_layouts.sql` is additive. Here's what it does:
- Creates the new table `packet_layouts`, with indexes and a select-only RLS policy.
- Adds 7 nullable columns on `packets`, plus a partial index.
- Widens `packet_fields.source` to add `'layout'`. It drops the old check by looking it up (whatever its name) and adds
  `packet_fields_source_check` with the four values. Every existing row stays valid.

It's idempotent: it was run twice on a throwaway local Postgres (PGlite) on top of migrations 1200–1700, with
checks for the unique active version, the source check and the MC format. It has **not** been run against Supabase.

## 6. Build plan after approval
1. `lib/packetFingerprint.js` (pure: normalize, text_hash, simhash, MC/domain extraction, `scoreLayout`, page mapping) with unit tests.
   **Done (pure library only, not wired in):** `app/lib/packetFingerprint.js` + `tests/js/packetFingerprint.test.mjs`. Choices made while building it:
   - The fallback rules take precedence over the point bands: rules 2 and 3 (MC or domain + fuzzy ≥ 0.8) apply even when the total is
     under 70 (e.g. 32 + 25 = 57), and rule 5 returns `changed` even when the total would be ≥ 45. Scans and an MC conflict never apply.
   - A page counts as text when it has ≥ 20 normalized letters. Pages without text join `layout_key` as `scan:WxH`, so scans with
     the same page sizes share a key. Scans are never treated as an exact match, but the learn step must not assume a scan's key is unique.
   - The MC regex also accepts `MC No.` / `MC Number:` and needs a non-letter before `MC` (so `SMC 1234` is ignored). Matching uses the
     base domain (`mail.tql.com` → `tql.com`). Forwarded `From:` lines count only when a Date/Sent/To/Cc/Subject header follows within 4 lines.
2. Changes to `packetProcess.js`: fingerprint, `findLayout`, apply/suggest, and skipping naming on matched pages. Changes to the inbound route: forwarded-From parse into `packets.broker_email`.
3. `lib/packetLayoutLearn.js`: diffing and versioning on fill. `/api/packets/[id]/layout` for dismiss/apply-suggested.
4. Banner and dismiss in `PacketMapper.js`. This doesn't touch `PacketSendBroker.js` or the COI files in #66. `app/packets/[id]/page.js` is
   also in #66, so the banner goes in `PacketMapper.js` only.
5. Tests: matching table (exact, fuzzy, MC veto, scans → suggest, changed form), RLS/role on the route, and that no values or
   signatures ever end up in `fields`.

## Not in scope
Driver Profile tab, sharing layouts between companies, and automatic placement on scanned packets (v2).
