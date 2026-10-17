# Truck tab: plan + wireframe (DRAFT, do not merge)

Status (Oct 17): **approved by Marc and built** on this branch (see PR #69). Migration `20261017002100_truck_tab.sql` was
**applied on prod by Dakota at 11:33 AM PT** after he checked the live `trucks`/`trailers` tables (they matched, no changes).
Decisions: Mileage moved inside Stats and Truck took its tab; weight warnings on; Company is a link only; no team drivers;
drivers get a read-only view. The plan below is kept as written for reference.

> **Migration `supabase/migrations/20261017002100_truck_tab.sql`: NEEDS SAM/MARC OK.** Not run anywhere. It is numbered after 20261017002000 (in main, unapplied) and #68's 20261017001900.

## 1. What the tab shows

1. **Truck & Trailer**: truck number, trailer number, truck plate + state, trailer plate + state, empty weights
   (truck, trailer), VIN, and scale-ticket weight history with the latest weight on top and a **Scan scale ticket** button.
2. **Driver**: name, phone, CDL number + state + expiration, med card expiration (badges), and the truck he drives.
3. **Company**: a link to the existing `/company` page. That page is not changed.

Wireframe screenshots: `powerhaul-docs/2026-10-17_truck-tab_wireframe_*.png` (393×852 and desktop).

## 2. Existing schema (checked)

- `trucks` and `trailers` exist in **prod** but were created outside this repo's migrations
  (columns per `docs/design/maintenance.md` §2: `trucks(id, user_id, unit_number, year, make, model, vin, license_plate,
  license_state, odometer, insurance_*, notes, timestamps)`, `trailers(... same base ..., trailer_type, length_ft)`).
  Both use own-row RLS (`user_id = auth.uid()`).
- `loads.truck_id` (uuid) and `documents.truck_id` (uuid, no FK; `20261010000050`) exist.
- The maintenance design (PR #28) proposed `trailers_extend` (0810), `documents.trailer_id`, `service_records` and the
  shared `dueStage()` helper. **None of that is in the repo yet** (no `app/lib/maintenance.js`, no 08xx migrations).
- `documents.doc_type` is plain text with no check constraint, so `scale_ticket` needs no SQL.

## 3. Data model (proposed, additive: `20261017002100_truck_tab.sql`)

| Change | Why |
|---|---|
| `trucks.empty_weight_lb`, `trailers.empty_weight_lb` (int, 0–100,000) | Empty (tare) weights |
| `trucks.current_trailer_id → trailers(id)` | Which trailer the truck pulls now |
| **new `drivers`** (`user_id`, `name`, `phone`, `cdl_number`, `cdl_state`, `cdl_expiry`, `med_card_expiry`, `truck_id → trucks`, `auth_user_id` (later), `active`, `notes`) | Driver card; linked to his truck. Partial unique: one active driver per truck. |
| **new `scale_tickets`** (`user_id`, `truck_id`, `trailer_id`, `document_id`, `load_id`, `ticket_date`, `gross_weight_lb`, optional axle weights, `scale_name`, `source manual\|ai`, `confirmed`) | Weight history. Unique on `document_id` so re-scanning a ticket updates instead of duplicating. |

- **Extends** `trucks`/`trailers`; no new truck table, no renames. The migration aborts with a clear message if either
  table is missing.
- **RLS:** own rows, `user_id = (select auth.uid())`, the same convention `trucks`/`trailers` use, with `exists` ownership
  checks on every referenced truck/trailer/document/load (same shape as the documents `load_id` rule).
  `packet_role(owner_id)` isn't used because the related vehicle tables are per-user. When company accounts reach
  vehicles, these policies move to the company role together with `trucks`/`trailers`.

## 4. Field-key mapping (`app/lib/truckFields.js`)

Keys are exactly the packet field names Alex added in **PR #67** (merged; `app/lib/packetFieldNames.js` `EXTRA_KEYS`). A
test checks that every Truck key is in `EXTRA_KEYS`. PR #68 (layout memory) only stores whatever `profile_key` a field has,
so it doesn't define new names.

| Field key | Table.column |
|---|---|
| `driver_name` | `drivers.name` |
| `truck_number` | `trucks.unit_number` |
| `trailer_number` | `trailers.unit_number` |
| `truck_plate` | `trucks.license_plate` |
| `truck_plate_state` | `trucks.license_state` |
| `trailer_plate` | `trailers.license_plate` |
| `trailer_plate_state` | `trailers.license_state` |

`fieldValuesFromRows({truck, trailer, driver})` gives packet fill values, and `columnsFromFieldValues(table, values)` gives
a save patch. Later, `packetFillValues` reads from it so packets auto-fill (one line per key, no renames).

## 5. Scale ticket scan flow

1. **Scan scale ticket** opens the existing Upload menu (`scanUpload.js`) and saves a `documents` row with
   `doc_type='scale_ticket'` and `truck_id` set.
2. The server reads it with the existing `ai-extract.js` `runExtraction`, adding a `scale_ticket` entry to `DOC_TYPES`
   (`{ ticket_date, gross_weight_lb, steer/drive/trailer axle, scale_name }`, numbers normalized, date parsed like receipts).
3. `docClassify` (merged with PR #66) gets `scale_ticket` keywords (CAT SCALE, GROSS, STEER, DRIVE, TANDEM, WEIGH), so a
   ticket uploaded under the wrong type is flagged.
4. A `scale_tickets` row is upserted on `document_id` with `source='ai'` and `confirmed=false`. The user checks the weight
   and date (editable) and taps Confirm. **Latest weight** = newest `ticket_date`, then `created_at`.
5. Rate limits reuse the extraction limiter, and AI is mocked in tests.

#66 is merged, so the build can edit `docTypes.js`, `docClassify.js` and `ai-extract.js` directly. It still avoids #68's files.

## 6. Expirations

CDL and med card use the §6.1 stages from `docs/design/maintenance.md` (30-day nudge, 14-day orange, red on the day).
These are **expiry kinds, so no grace**: "EXPIRED n days" starts the day after. The 5-day grace applies only to DOT
annual/PM. The wireframe uses `expiryBadge()` with the same constants, and it switches to the shared `dueStage()` once
maintenance lands.

## 7. Growth path: many trucks and drivers

- The schema is already 1-to-many: `drivers.truck_id` and `scale_tickets.truck_id`, and the owner has N trucks/trailers/drivers.
- UI: one truck shows directly. With 2+ trucks, a **truck picker** appears at the top (`/truck?unit=104`) and later a
  **Fleet** list (`/truck/all`) with the worst badge per truck. A driver's own login (`drivers.auth_user_id`, company
  member) sees only his truck.
- Team drivers would mean relaxing the one-active-driver-per-truck index (open question).

### 7a. Known limitation: which truck a driver sees (Taylor QA, Oct 17)

A driver's Truck tab shows the truck whose `drivers.auth_user_id` is linked to his login. **If no driver row is linked to
his login, he currently sees the company's first truck and its driver anyway.** That's fine while there is one truck.
**Revisit this when there are more trucks:** link each driver login to its driver row (and so to its truck), and show
"No truck assigned" instead of falling back to the first truck.

## 8. Files (build PR)

`app/truck/page.js` (tab), `app/truck/TruckCard.js`, `DriverCard.js`, `ScaleHistory.js`, `app/api/truck/route.js` (GET/PATCH
via mapping), `app/api/truck/scale-tickets/route.js` (scan → extract → upsert, confirm), `app/lib/truckFields.js` (this PR),
`ai-extract.js` (+`scale_ticket`), `docTypes.js` (+Scale ticket), `docClassify.js`, `AppNav.js` (per (a)).

## 9. Tests

This PR has the mapping module (keys, columns, patches, badges, latest weight), the wireframe production gate and no-DB
check, and the migration being additive with own-row RLS. The build PR adds route tests with the fake Supabase
(ownership, 403/404, upsert idempotency on `document_id`), extraction normalization (`"78,420 LB"` → 78420), the classifier
for scale tickets, and the packet auto-fill from the mapping.

## 10. Open questions for Marc

**(a) Tab placement.** The bottom bar already has 6 tabs (Home, Stats, Loads, Docs, Expenses, Mileage); a 7th won't fit at 393px.
- **A. Fold Mileage into Stats, then add Truck (recommended).** Mileage is mostly IFTA reporting, which fits Stats, and the ELD import moves with it. Truck becomes a first-class daily tab.
- B. Replace Home with Truck. Home's links move into the top bar. Saves a tab, but Home is the landing page.
- C. Put Truck under the top-bar avatar menu next to Company. No nav change, but it's harder to find on a phone.

**(b) Weight checks.** Show **net cargo = gross − (truck empty + trailer empty)** on each ticket, and warn when gross is
**over 80,000 lb** (and per axle group: steer 12,000 / drive 34,000 / trailer 34,000)? Also compare with the load's
`weight` from the rate con (e.g. flag a >10% difference)?

**(c) Company fields.** Any extra fields to add to Company (e.g. IFTA account, IRP account, UCR year, SCAC, insurance agent)?
Or should the Truck tab only link there, as planned?

Also: team drivers (two active drivers per truck)? Should drivers see the Truck tab read-only?
