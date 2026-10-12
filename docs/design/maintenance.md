# Truck & Trailer Maintenance v1 (M1): design

> **Status: DESIGN ONLY. All open questions resolved; Taylor's review fixes applied, ready for re-review.** This PR adds no migrations or app code. Taylor reviews it, then Marc approves. Marc's schema output (Oct 11) is in §1, and the few items it couldn't show are verify-at-build checks (§1.1), not questions.
> The build starts **after Alex's scanner PR merges**. Core owner-operator fixes always take priority.
> Every SQL block below is **illustrative**, not a migration.
> Source spec: `/workspace/plans/maintenance-spec-v1.md` (Drew's spec, trimmed per Dakota on Oct 11).

## 0. Scope

**v1 (this doc)**
- Vehicles: **trucks and trailers from day one.** Extend the existing `trucks` table and the `trailers` table Marc created on Oct 11 (already live, RLS set). Both get odometer/engine hours (reefer unit hours on trailers) and due dates.
- `service_records`: date, odometer, engine hours, service type, free-text vendor, costs, and **multiple scanned documents / pages** (up to 10).
- Scanned maintenance docs go through Alex's scanner. v1 only stores and links them; there's **no OCR prefill**.
- Service costs flow into Expenses **exactly once**.
- Per-vehicle due dates (DOT annual, registration, IRP, plate) are shown with a staged countdown badge (§6.1: OK → Due soon → Due today → Overdue/grace for DOT and PM, EXPIRED for legal expiries; §6.1). **v1 sends no alerts.**
- A per-vehicle history page (timeline).

**v2: out of scope, but the design leaves room for it without rework**

| v2 feature | Hook left in v1 |
|---|---|
| PM schedules and alerts (miles / engine hours / days, whichever comes first), seeded with Drew's default intervals (PM A 25k mi / 500 hr / 6 mo, PM B 50k / 1,000 hr / 12 mo, etc., listed in the spec) | `service_records.service_type`, `odometer` and `engine_hours` are captured now. A later `pm_schedules (vehicle, service_type, interval_miles, interval_hours, interval_days)` table reads "last done" from `service_records`. The badge helper (§6) is reused. |
| Weekly odometer prompt | `trucks.odometer_updated_at` / `trailers.odometer_updated_at` |
| OCR prefill | Add a `'maintenance_invoice'` entry to `DOC_TYPES` in `app/lib/ai-extract.js` and add the kind to `extraction_runs_kind_check` (§7). |
| Vendors | `service_records.vendor_name` is free text now. A nullable `vendor_id` and a backfill from distinct names come later. |
| CSV export and import, bulk PDF import | Plain columns now, so v2 needs no reshaping. |
| Tires | `service_type = 'tires'` records now. A `tires` table later, which can reference `service_records.id`. |
| Cost per mile and cost reports by type | `service_type`, `total`, `odometer` and the expense link are all in place (§5 note). |
| DOT inspection details (pass/fail, defects) | v1 keeps only the date on the vehicle plus a `dot_annual` service record with its scanned report. |

**Deferred:** parts inventory, work orders, ELD odometer sync, warranties.

**Constraint:** nothing about loads, expenses, mileage or the dashboard changes for Marc unless he adds a service record.

## 1. Current schema (confirmed by Marc's query, Oct 11)

All three tables were created in prod outside `supabase/migrations`. Marc's output gave column names and types. Nullability, defaults, FKs, policies and triggers weren't included, except `loads.status default 'booked'`.

| Table | Columns (type) |
|---|---|
| `trucks` | id uuid, user_id uuid, unit_number text, year integer, make text, model text, vin text, license_plate text, license_state text, **odometer integer**, **insurance_provider text, insurance_policy text, insurance_expiry date**, notes text, created_at timestamptz, updated_at timestamptz |
| `trailers` | id uuid, user_id uuid, unit_number text, year integer, make text, model text, vin text, license_plate text, license_state text, trailer_type text, length_ft integer, notes text, created_at timestamptz, updated_at timestamptz (RLS own-rows, per Marc) |
| `loads` | **id uuid**, user_id uuid, **truck_id uuid**, status text default 'booked', broker_name, broker_load_number, rate numeric, rate_per_mile numeric, commodity, weight integer, equipment_type, special_instructions, total_miles integer, notes, created_at, updated_at |

What this settles:
- Trucks **already have** `license_plate`/`license_state`, so there's no rename. They also have `odometer` (not re-added) and insurance fields. **`trucks.insurance_expiry` is used as a due date** with the §6.1 `dueStage` badges ("Insurance"), instead of adding a duplicate column. Trailers have no insurance fields, and none are added in v1 (trailer coverage is usually on the truck/fleet policy).
- `loads.id` is uuid, so `service_records.load_id uuid references loads(id)` holds. `loads.truck_id` is uuid, so a later FK to `trucks` is possible (not in v1).
- `documents.truck_id` (uuid, no FK) is from the repo (`20261010000050`). `mileage_entries` has no `truck_id`.

### 1.1 Verify at build (defensive migrations; no need to ask Marc again)

Each migration checks the catalog first and only changes what's missing:
- **`user_id` default:** `alter column user_id set default auth.uid()` only if `column_default is null` (trucks, trailers).
- **`user_id` not null / FK to `profiles`:** add the FK `not valid` only if no FK exists on that column. Set `not null` only if no null rows exist; otherwise skip and report.
- **`id` default:** set `gen_random_uuid()` only if missing.
- **`updated_at` trigger:** `create trigger … execute function set_updated_at()` only if no trigger on the table already updates `updated_at` (`if not exists` check on `pg_trigger`). Also set the `created_at`/`updated_at` default `now()` if missing.
- **RLS on `trucks`:** if RLS is off or has no own-row policies, enable it and create `user_id = (select auth.uid())` policies. If it already has policies, they're left alone unless they're broader than own-rows, which is reported, not silently replaced. `trailers` RLS is left as Marc set it.
- **Unique indexes** (`unit_number` per user among non-sold units, VIN per user): created only if no duplicates exist; otherwise skipped and reported.
- **`documents` doc_type check:** extended only if one exists.
- The build PR's description includes the output of these checks run against prod (read-only), before Marc runs the migrations.

## 2. Data model

### 2.1 `trucks`: EXISTS. Add maintenance columns only (PROPOSED)

The existing columns (§1) stay as they are, with no renames and no re-adds. `20261012000800` runs `add column if not exists` for **only** these:

| Column | Type | Notes |
|---|---|---|
| odometer_updated_at | timestamptz | `odometer` already exists |
| engine_hours, engine_hours_updated_at | numeric(10,1), timestamptz | `>= 0` |
| in_service_date | date | |
| status | text not null default 'active' | `check (status in ('active','out_of_service','sold'))` (§6.2) |
| sold_at | date | `check ((status = 'sold') = (sold_at is not null))` `not valid` |
| dot_annual_due, registration_due, irp_due, plate_due | date | due badges. **Insurance uses the existing `insurance_expiry`.** |

Checks on existing columns are added `not valid`: VIN `^[A-HJ-NPR-Z0-9]{17}$`, `year between 1980 and 2100`, `license_state ~ '^[A-Z]{2}$'`, `odometer >= 0`. Indexes: `unique (user_id, unit_number) where status <> 'sold'` (reuse confirmed, §6.3), `unique (user_id, vin) where vin is not null`, `(user_id, status)`, all subject to §1.1.

### 2.2 `trailers`: EXISTS. Add maintenance columns only (PROPOSED)

The table, its RLS and the base columns (`id, user_id, unit_number, year, make, model, vin, license_plate, license_state, trailer_type, length_ft, notes, created_at, updated_at`) are already in prod. **No `create table`.** The migration only runs `add column if not exists` for:

| Column | Type | Notes |
|---|---|---|
| odometer, odometer_updated_at | int, timestamptz | hub reading, optional, `>= 0` |
| engine_hours, engine_hours_updated_at | numeric(10,1), timestamptz | reefer unit hours; null for non-reefers |
| in_service_date | date | |
| status, sold_at | text not null default 'active', date | same checks as trucks |
| dot_annual_due, registration_due, plate_due | date | v1 due badges. IRP applies to power units, so trailers have no `irp_due`. |

- `trailer_type` stays free text as Marc created it. The UI offers presets (`dry_van, reefer, flatbed, step_deck, tanker, other`) and shows engine hours fields when it's `reefer`. No DB check is added, so existing values never block anything.
- New checks (VIN format, year range, `license_state`) are added `not valid`, and the indexes `unique (user_id, unit_number) where status <> 'sold'`, `unique (user_id, vin) where vin is not null` and `(user_id, status)` are created `if not exists`. If existing rows have duplicates, that index is skipped and flagged to Marc rather than failing.
- **RLS is left as Marc set it.** The `user_id` default and FK and the `updated_at` trigger are handled defensively per §1.1.

### 2.2a How a record points at a truck or a trailer (decision)

**Decision: two nullable FKs, `truck_id` and `trailer_id`, with `check (num_nonnulls(truck_id, trailer_id) = 1)`.** I rejected the `asset_type + asset_id` alternative because:
- **Real FKs.** Postgres can't put a foreign key on a polymorphic `asset_id`, so we'd lose referential integrity and FK enforcement (`on delete no action`) (a trailer with history can't be deleted out from under its records). We'd need triggers to fake that.
- **Simpler RLS.** The ownership check is two plain `exists` clauses against tables that already enforce `user_id = auth.uid()`, the same shape as `0700`/`0710`. A polymorphic one needs a `case` on `asset_type`, which is easy to get wrong.
- **Joins and the PostgREST embed** (`service_records(..., trucks(unit_number), trailers(unit_number))`) work directly, and later composite company FKs (PR #27) fit cleanly.
- The cost is one extra nullable column per table. With only two vehicle kinds that's fine. If a third kind ever appears, we add a third FK and widen the check.

The same pattern applies everywhere a maintenance row references a vehicle: `service_records` (v1), the v2 `pm_schedules` table, and future inspection-detail and tire tables. Due dates in v1 live on the vehicle row itself (§2.1/§2.2), so badges just read whichever table the unit is in.

### 2.3 `service_records` (NEW)

```sql
-- ILLUSTRATIVE
create table public.service_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  truck_id uuid references public.trucks(id) on delete no action,
  trailer_id uuid references public.trailers(id) on delete no action,
  vehicle_snapshot jsonb not null default '{}'::jsonb,  -- unit_number, vin, make, model, year at save time (§6.3)
  load_id uuid references public.loads(id) on delete set null,  -- optional; most records have none
  service_date date not null,
  odometer int check (odometer >= 0),
  engine_hours numeric(10,1) check (engine_hours >= 0),
  service_type text not null check (service_type ~ '^[a-z0-9_]{2,40}$'),
  vendor_name text check (length(vendor_name) <= 120),   -- v2: + vendor_id uuid null
  invoice_number text,
  description text,
  parts numeric(12,2) check (parts >= 0),
  labor numeric(12,2) check (labor >= 0),
  tax numeric(12,2) check (tax >= 0),
  total numeric(12,2) not null check (total >= 0),
  downtime_days numeric(5,1) check (downtime_days >= 0),
  notes text,
  -- documents link back via documents.service_record_id (many per record, §2.4)
  expense_id uuid unique references public.expenses(id) on delete no action,  -- NO ACTION (not restrict) so a user-delete cascade can remove both rows in one statement (§3.1)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_records_one_vehicle check (num_nonnulls(truck_id, trailer_id) = 1)
);
create index on public.service_records (user_id, truck_id, service_date desc);
create index on public.service_records (user_id, trailer_id, service_date desc);
```

- **Total:** the user enters `total`. When parts, labor or tax are given, the UI suggests their sum but doesn't force it, because invoices carry shop fees.
- **`service_type`** is text with a loose format check. The preset list lives in JS (`app/lib/maintenance.js`, `SERVICE_TYPES`) so it's easy to extend without a migration: `oil, fuel_filter, air_filter, def_dpf, coolant, trans_diff_fluid, grease, brakes, tires, alignment, battery, ac, dot_annual, pm_a, pm_b, reefer_service, repair, other`. The UI shows labels and allows "other" plus a description. A strict DB enum is rejected, because Drew wants the list editable.
- **Many documents per record (Marc, Oct 11):** normal services are 1–3 pages, so a record can have several files and/or multi-page scans. See §2.4.
- Saving a `dot_annual` record (truck **or** trailer) offers to set that vehicle's `dot_annual_due` to `service_date + 12 months`. The user confirms; nothing is silently overwritten.
- Saving a record with a higher `odometer` or `engine_hours` than the vehicle's current value offers to bump the vehicle's reading.

### 2.4 Maintenance documents: reuse `documents`

- New `doc_type` values: `'maintenance_invoice'` and `'dot_inspection'` (service records), plus vehicle documents `'vehicle_title'`, `'vehicle_registration'`, `'vehicle_insurance'`, `'bill_of_sale'` and `'other_vehicle_doc'` (§2.5). There's no doc_type check constraint in the repo today (verified at build, §1.1). If prod has one, the migration extends it.
- **Approved (Marc, Oct 11): documents link directly to a truck or trailer**, with no service record needed. `documents.truck_id` **already exists** (uuid, no FK, client-insertable; `20261010000050`), and v1 adds an FK `not valid` to `trucks`. We add **`documents.trailer_id uuid`** (FK `not valid` to `trailers`). Both use `on delete no action` (checked at statement end, so user-account cascades work; §3.1), because vehicles aren't deleted, only sold (§6.2). A check `num_nonnulls(truck_id, trailer_id) <= 1` means a document belongs to at most one vehicle. `trailer_id` is added to the client insert/update column grants, with the ownership check in §4.
- `documents.truck_id` gets an FK `not valid` to `trucks`. The RPC sets each attached doc's `truck_id`/`trailer_id` to match the record's vehicle.
- **Multiple documents per record: decision is `documents.service_record_id` (FK) + `documents.page_order`, not a join table.**
  ```sql
  -- ILLUSTRATIVE (migration 0830)
  alter table public.documents
    add column service_record_id uuid references public.service_records(id) on delete cascade,
    add column page_order smallint check (page_order between 1 and 10);
  -- deferrable so a reorder (swap 1↔2) can be done in one transaction (item 11)
  alter table public.documents add constraint documents_record_page_uniq
    unique (service_record_id, page_order) deferrable initially deferred;
  ```
  - *Why:* a scanned invoice page belongs to exactly one service record, and nothing in v1 shares a page between records. So the relationship is one-to-many, and a join table would add a third table plus its own RLS for no benefit. With the FK, ownership is one more `exists` in the documents policies (the record's `user_id = auth.uid()`, same shape as `load_id` in `0710`), and `on delete cascade` handles cleanup.
  - *Writes:* `service_record_id`/`page_order` are **not** in the client column grants. Only `save_service_record` sets them (security definer with owner checks, §3), passing the ordered `document_ids`. The documents policies also require the record to be owned by the caller.
  - **Cap:** at most **10 documents per record** (enforced in the RPC and the UI). Each file uses the existing documents limits: 10 MB per file and the same allowed types as receipts (PDF, JPEG, PNG, HEIC → JPEG). A multi-page PDF counts as one document, and **PDFs are also capped at 20 pages each** (checked client-side with pdf.js before upload, and re-checked server-side when v2 extraction reads the file). So the limits are 10 documents, 10 MB per file and 20 pages per PDF.
  - The synced expense's `document_id` points at the first page (`page_order = 1`), so the Expenses list still shows a thumbnail. The other pages are reached from the record.
- Upload goes through Alex's scanner component (shared upload menu, type/size checks, HEIC conversion). v1 only stores the files and links them.
- **Form attachments:** an "Add pages" button opens the shared menu. **Camera multi-capture** lets the user take page after page and tap Done, or the **file picker** allows multi-select (`multiple`). Pages show as a thumbnail strip with a page number, **drag/arrow reorder** and **remove (×)**, plus an "N/10" counter, and the add button disables at 10. Each file uploads immediately with its own progress and retry. Saving waits for pending uploads. Files removed or abandoned before saving are deleted by the client (best effort). The v1 sweep (§5) cleans orphans older than 24 h.
- **Required in PR 5:** the Documents page (`app/documents/page.js`) must filter to rate con doc types only (maintenance and vehicle docs are excluded; they live in the vehicle Documents tab and Alex's vault). PR 5 includes a regression test that the rate con list is unchanged (same rows, order and count) after maintenance and vehicle docs exist.

### 2.5 Vehicle documents (title, registration, insurance, bill of sale…)

- A document with `truck_id` or `trailer_id` set and **no `service_record_id`** is a **vehicle document**. Doc types are `vehicle_title`, `vehicle_registration`, `vehicle_insurance`, `bill_of_sale` and `other_vehicle_doc` (with `original_filename` as its label). The list lives in JS (`VEHICLE_DOC_TYPES` in `app/lib/maintenance.js`), and a DB check is only extended if prod has one (§1.1).
- **Storage path:** `{uid}/vehicles/{truck|trailer}/{vehicle_id}/{ts}-{safeName}`. The first segment is still `{uid}`, so the existing `documents_insert_own` rule and the bucket policies already allow it, with no storage policy change. Limits are the same as other documents (10 MB per file; PDF/JPEG/PNG/HEIC). Service-record pages keep their `{uid}/maintenance/...` path (§5).
- **RLS:** insert and update require that `truck_id`/`trailer_id`, when set, belong to the caller (`exists` on `trucks`/`trailers`). Select and delete stay `user_id = auth.uid()`. A vehicle doc can't be attached to a vehicle that's sold (UI check, plus the RPC for service records).
- **Documents tab** on `/maintenance/trucks/[id]` and `/maintenance/trailers/[id]` (tabs: Overview · History · **Documents**):
  - **Upload** goes through Alex's shared upload menu (camera or file). The user picks a type, which defaults to `other_vehicle_doc`.
  - **List** is grouped by type, newest first, with thumbnail, name, date and type. Service-record pages also appear in a collapsed "From service records" group that links to the record.
  - **View** opens a signed URL, same as today.
  - **Delete** asks for confirmation, then removes the row and the storage object. Service-record pages are removed from the record form, not here.
- **Sold vehicles:** documents stay attached and visible **read-only** in the Archive (no upload or delete). They fall under the §6.2 retention rule (kept 1 year after `sold_at`, then deletable by the user, never auto-deleted). Receipts attached to expenses are never deleted with the vehicle, and Restore makes them editable again. A `bill_of_sale` upload is suggested when marking a unit sold.
- **Alex's document vault:** the vault is the cross-cutting view of all documents. Vehicle docs are ordinary `documents` rows, so the vault lists them automatically. It can filter by vehicle (`truck_id`/`trailer_id`) and type, and its checklist can flag a missing registration or insurance per active vehicle. Its send picker can attach them (e.g. registration plus insurance for a broker or a DOT stop). The vehicle Documents tab and the vault share the same upload component and doc-type list, so nothing is duplicated. Exact vault UI and naming are Alex's call, and I'll coordinate with Alex before the build.

## 3. Costs flowing into Expenses (one source of truth)

**Decision: the `expenses` row is the money record, and `service_records.expense_id` (unique) links to it.** The dashboard (`app/lib/dashboard.js` `aggregate()`) and per-load totals (`app/components/LoadExpenses.js`) keep summing **only `expenses`**. Nothing ever sums `service_records.total` into those numbers, so nothing can be counted twice.

- **Decision (Marc, Oct 11): every service record ALWAYS creates an expense line**, for any maintenance on a truck or trailer, **including $0** (warranty or goodwill work), so it all shows up in reports. There is **no "don't add to expenses" option**.
- Each service record owns **exactly one** expense: category `maintenance`, amount = `total` (may be `0.00`), `expense_date` = `service_date`, description `"{Truck|Trailer} {unit} · {service type} · {vendor}"`, `document_id` = the record's first page (`page_order = 1`, or null if no docs), and `load_id` = the record's `load_id`.
- **Optional load (Marc, Oct 11: yes, optional).** `service_records.load_id` is nullable and defaults to none; most records won't have one. When set, it's copied to the synced expense's `load_id`, so the cost counts in that load's net (`LoadExpenses`). Clearing it clears the expense's `load_id` too.
- **$0 is allowed everywhere:** `service_records.total >= 0`, the existing `expenses_amount_nonneg` check from `0700` (`amount >= 0`), the RPC (rejects only null/negative/non-numeric totals) and the form (`min="0"`; the current Expenses validation `amount < 0` already accepts `0`). **`0700` does not block $0, so no migration change is needed.**
- **How $0 lines show in reports:** they are listed like any other line, shown as `$0.00` with a small "No charge" tag (and "Warranty" when the service note or type says so). They add nothing to totals but do count in the record and expense counts, and they appear in the vehicle's history and the Expenses list, so the work is still tracked.
- **No new columns on `expenses`.** We can tell an expense came from a service record with `exists (select 1 from service_records where expense_id = e.id)`. The expenses list shows a "From service record" tag and links to the record using that join (`expenses.select('..., service_records(id)')`).
- **Linking an existing expense** (if the shop bill was already logged): the picker lists the caller's unlinked expenses. The `unique` on `expense_id` guarantees one-to-one. Rules:
  - **Category:** must be `maintenance`. If it isn't, the UI asks "Change category from Fuel to Maintenance?", and only on confirm does the RPC convert it. Without the confirm (`p.convert_category = true`), the RPC raises `22023`.
  - **Amount and date are overwritten** from the record (`total`, `service_date`). Before saving, the UI shows a diff ("Amount $480.00 → $512.40, Date Sep 26 → Sep 27"), and the user confirms.
  - **Receipt:** an existing `expenses.document_id` is **never replaced**. Only a null one is set to the record's page 1.
  - **Description and load:** description becomes the record format. `load_id` follows the record.
  - **Unlink** (removing the link, or `delete_service_record(keep_expense => true)`): the expense keeps its current values (amount, date, category, description, receipt). Nothing is reverted.
- **Transactional writes through RPCs. `SECURITY DEFINER` (decision, per Taylor's review).** Client `insert`/`update` on `service_records` and the `documents.service_record_id`/`page_order` column grants are revoked, so security-invoker RPCs would fail with permission denied. All maintenance RPCs (`save_service_record`, `delete_service_record`, `delete_archived_vehicle`) are therefore:
  - `security definer` with `set search_path = public, pg_temp`, and all objects schema-qualified.
  - They read `v_uid := auth.uid()` once, raise `42501` if it's null, and **check every id against `v_uid`**: the vehicle, load, each document, the expense, and the existing record on update. Every write also filters on `user_id = v_uid`, because RLS is bypassed inside.
  - `revoke execute … from public, anon; grant execute … to authenticated`.
  - Inputs are validated (types, ranges, array length ≤ 10, no duplicate doc ids). Errors use fixed codes and never echo other users' data.
  - **Idempotent save:** the client generates the record `id` (it reuses the form's `batch_id`) and sends it on every attempt. The RPC does `insert … on conflict (id) do update` (guarded by `where service_records.user_id = v_uid`, else `42501`). The expense is created only when `expense_id` is null, and is otherwise updated **through `expense_id` only**, so a retried or double-tapped save never creates a second record or expense.
  - `save_service_record(p jsonb) returns uuid` takes **either** `truck_id` or `trailer_id` (exactly one, else it raises `22023`), checks the caller owns that vehicle, inserts or updates the record, upserts its expense (amount, including `0`, date, description, document, load), takes an ordered `document_ids uuid[]` (0–10; each must be the caller's, maintenance `doc_type`, and not attached to another record), sets their `service_record_id`/`page_order` (in one statement, relying on the deferred unique constraint; item 11) and unlinks any removed ones, checks the optional `load_id` is a load the caller owns (`exists` on `loads` with `user_id = auth.uid()`, else it raises `42501`), and syncs the document's `truck_id`/`trailer_id`, all in one transaction. Moving a record to another unit (truck to trailer or vice versa) clears the old FK. The optional "bump reading" / "set DOT due" confirmations are applied to whichever table the vehicle is in.
  - `delete_service_record(p_id uuid, p_keep_expense boolean default false)`, in this order in one transaction:
    1. Lock the record (`for update`) and check `user_id = v_uid`.
    2. **Protect receipts:** on any document that some expense uses as `document_id` (normally page 1), set `service_record_id = null, page_order = null`, so the cascade can't delete it.
    3. Set the guard flag, then `delete` the record. The remaining page docs cascade, and their `file_path`s are first inserted into `storage_delete_queue` (§5).
    4. If not `p_keep_expense`, delete the expense. Its receipt document is then unreferenced and queued too. It works the same for truck and trailer records. The vehicle row is never touched. A linked pre-existing expense defaults to kept, and the UI asks which the user wants.
- **Guard against drift:** a trigger on `expenses` rejects `update`/`delete` of a linked expense unless `current_setting('app.service_record_sync', true) = 'on'`. The RPCs set that flag with `set_config(..., true)`, which is transaction-local. The Expenses page shows linked rows read-only with "Edit in Maintenance". The `expense_id` FK (`on delete no action`) is a second guard against a direct client delete.

### 3.1 Account deletion (Taylor item 3)

Deleting a user deletes `profiles`, which cascades to `service_records`, `expenses` and `documents` (all `user_id … on delete cascade`). To keep that from failing:
- `service_records.expense_id` and the `truck_id`/`trailer_id` FKs are **`on delete no action`**, not `restrict`. NO ACTION is checked at the end of the statement, so when one cascade removes both the record and its expense (or vehicle), the check passes.
- The guard trigger **allows the delete** when `pg_trigger_depth() > 1` (we're inside a cascade) **or** no `service_records` row references the expense anymore (`not exists (select 1 from service_records where expense_id = old.id)`). It still blocks a direct client delete of a linked expense.
- Test: create a user with trucks, trailers, records (with pages and linked expenses) and vehicle docs, then delete the auth user. The delete succeeds, no rows remain for that user, and their storage paths are queued.
- **Existing constraints** in `0700` (`expenses_amount_nonneg`: `amount >= 0`, category list including `maintenance`, date present) are already satisfied, including for $0 records.

## 4. RLS (today's `user_id = auth.uid()` pattern)

| Table | select | insert / update | delete |
|---|---|---|---|
| trucks | `user_id = (select auth.uid())` | same, with check | same |
| trailers | **already set by Marc** (own rows only); verified, not replaced | — | — |
| service_records | own | own **and** the referenced truck *or* trailer (whichever is set), the optional load, document and expense all have `user_id = auth.uid()` (`exists` checks, like `0700`/`0710`) and `documents.doc_type` is a maintenance type | own |

- **Leftover broad policies (Taylor item 4):** migrations 0800, 0810, 0820 and 0830 first scan `pg_policies` for `trucks`, `trailers` and `documents`, and **`raise exception`** (aborting the migration) if any policy isn't own-rows. **Accepted (Taylor R4):** `qual` (and `with_check` where present) contains `user_id = auth.uid()` **or** `user_id = (select auth.uid())` (either operand order, with or without casts and `public.`), optionally **AND-ed with extra conditions** (e.g. the `exists` ownership checks this design adds). **Rejected:** `true`, role-only policies, any top-level `OR` that could widen access, or a policy with no `user_id`/`auth.uid()` predicate. Roles must be `authenticated` (or `public` with that predicate). So re-running 0820/0830 doesn't abort on the policies they create themselves. The fix is then made deliberately rather than shipped. The build PR **pastes the full `pg_policies` output** for these tables. If `trucks` has no policies, the own-row set is created (with existence guards).
- **`service_records` policies, explicit:** `sr_select_own` (`using user_id = auth.uid()`), `sr_insert_own` (`with check user_id = auth.uid()` and the vehicle/load/expense ownership `exists`), `sr_update_own` (`using` + `with check`, same predicates), and `sr_delete_own` (`using user_id = auth.uid()`). Client grants are `select` and `delete` only. Insert and update happen inside the definer RPCs, and the policies are defense-in-depth if a grant is ever widened.
- `documents.truck_id` / `documents.trailer_id`: update `documents_insert_own` and `documents_update_own` to also require that each is null or owned by the user (`exists` against `trucks` / `trailers`), mirroring the `load_id` rule in `0710`.
- `service_records` writes are **RPC-only** (security definer, §3). `user_id` and `expense_id` can't be changed directly.
- **Company accounts (PR #27):** later, `trucks`, `trailers` and `service_records` get `company_id`, with composite FKs to keep the vehicle, document and expense in the same company. A future vendors table gets `company_id` too. The cross-row `exists` checks become company checks, and the RPCs take the company from the vehicle.

## 5. Storage

**Storage cleanup (Taylor item 10): `storage_delete_queue (id, user_id uuid not null, bucket, path, queued_at, attempts, last_error)`**. **`user_id` is a plain uuid with no FK (Taylor R2)**, so deleting an account doesn't cascade-wipe its queued paths, and the files still get cleaned up. RLS: the app can **select and delete only its own rows** (`user_id = (select auth.uid())`), with no client insert or update. It's written only by the definer RPCs and by an `after delete` trigger on `documents`). Every RPC that deletes documents inserts their paths **inside the same transaction**, so a crash can't lose them. The client drains its own queue after the RPC returns (deleting objects via the storage API and then the queue rows), and **a v1 scheduled sweep** (**daily**, pg_cron + pg_net calling an edge function; see §5.1) retries anything left over. It also removes upload orphans: `documents` with no record, vehicle or expense link that are older than 24 h, under `/maintenance/`.

### 5.1 Cleanup job security (Taylor R1)

- **Secrets:** the **service role key lives only in the edge function's secrets** (`supabase secrets set`). It's never in SQL, migrations, client code or the repo. The cron job authenticates with a separate **shared secret** sent in an `x-cleanup-secret` header. That secret is stored in **Supabase Vault** (read by the cron SQL via `vault.decrypted_secrets`) and in the function's secrets. The function **rejects any call** without a matching header (constant-time compare, `401`), and has JWT verification off only because the header replaces it.
- **Scope (allow-list):** it deletes only (a) paths in `storage_delete_queue`, and (b) unlinked uploads under `{uid}/maintenance/` older than 24 h (a `documents` row with no `service_record_id`, no vehicle link and not any expense's `document_id`, or a storage object with no `documents` row). It **never touches `/vehicles/`, rate cons or receipts**: paths must match `^[0-9a-f-]{36}/maintenance/`, and anything else is skipped and logged.
- **Re-check right before each delete:** in the same transaction as the claim, the function confirms **no `documents` row points at the path** and **no expense uses it as a receipt** (`expenses.document_id` → that doc), and that the path's first segment **equals the queue row's `user_id`**. If any check fails, the queue row is dropped without deleting the file, and this is logged.
- **Re-runnable:** batches of 100 are claimed with `select … for update skip locked`, so two runs can't overlap on the same rows. A queue row is removed **only after the file is confirmed gone**, and a storage 404 counts as gone. On error it does `attempts += 1, last_error = …`. Rows with `attempts >= 10` are skipped (left for manual review and listed in the function log). Running it twice in a row is a no-op the second time.
- **Schedule:** daily at 03:15 PT (`cron.schedule('maintenance-storage-cleanup', '15 10 * * *', …)` in UTC; 10:15 UTC is 03:15 PDT, 02:15 PST).

Paths are `{uid}/maintenance/{truck|trailer}/{vehicle_id}/{batch_id}/{nn}-{ts}-{safeName}`, where `batch_id` is a client UUID per form session (the record id isn't known before the first save) and `nn` is the capture order. For example: `{uid}/maintenance/trailer/9f2c…/b71e…/02-1760300000-page.jpg`. Display order comes from `page_order`, not the path. The unit segment is only for browsing and cleanup; the DB FKs are authoritative. That already satisfies `documents_insert_own` (`split_part(file_path,'/',1) = uid`) and the bucket policies in `20261010000000_documents_bucket.sql`, so no storage policy changes are needed. Allowed types and the 10 MB limit are unchanged (`0000`, `0300`). After company accounts, these become `{company_id}/{uid}/maintenance/...`.

*Cost per mile (v2 note):* sum the vehicle's maintenance totals for the period and divide by its miles for that period. Odometer deltas from `service_records` or vehicle readings work for this, since `mileage_entries` has no `truck_id`. For trailers it's per hub mile if hub readings are entered, otherwise per load mile. There's nothing to build in v1.

## 6. Per-vehicle UI

- **`/maintenance`:** one vehicle list with a **Trucks / Trailers** segmented filter (default All). Each row shows a type icon, unit, trailer type (for trailers), status, current odometer and engine hours, and the worst due badge. "Add vehicle" asks Truck or Trailer first. Trailer add/edit writes to Marc's `trailers` table, using his column names.
- **Unit picker** in the service record form: a single searchable list grouped **Trucks** then **Trailers** (`T-101 · 2019 Freightliner`, `TR-12 · Reefer 53 ft`). Selecting a unit sets `truck_id` or `trailer_id`.
- **Load (optional)** picker in the same form, defaulting to **"No load"**, listing the user's loads (most recent first). Amount accepts `0.00` with the hint "Use $0 for warranty / no-charge work". Engine hours show for trucks and reefer trailers. The `irp` service and due field are hidden for trailers.
- **`/maintenance/trucks/[id]` and `/maintenance/trailers/[id]`:** vehicle details plus a **history timeline** of service records (newest first; date, type, vendor, total, odometer/hours, document link) and the due-date list.
- **Due badges:** see §6.1. They cover DOT annual, registration, IRP and plate, plus **insurance (`trucks.insurance_expiry`, existing column)** for trucks. v2 reminders reuse the same helper. **No notifications in v1.**

### 6.1 Due-date stages (decision: Marc, Oct 11)

Starting 30 days before the due date, a soft nudge shows a **live countdown** ("Due in 12 days"). The color escalates as the date gets close. After the due date, **DOT annual and PM** get a 5-day grace period, then the strongest alert from day 6. **Insurance, registration, IRP and plate** have no grace: they show "EXPIRED {n} days" in strongest red from the day after expiry.

`d = dueDate − today` in whole days:

| Stage key | Days left `d` | Label (text is always shown) | Color / style | Icon |
|---|---|---|---|---|
| `none` | no date | "No date set" | neutral grey outline | — |
| `ok` | `d > 30` | "Due Mar 3" (date) | neutral, no fill | — |
| `soon` | `30 ≥ d ≥ 15` | "Due in {d} days" | yellow | clock |
| `near` | `14 ≥ d ≥ 1` | "Due in {d} days" / "Due tomorrow" (d=1) | orange | clock |
| `today` | `d = 0` | "Due today" | red | alert |
| `expired` | `d ≤ −1`, **expiry kinds only** (insurance, registration, IRP, plate) | "EXPIRED {−d} day(s)" | strongest red (as `now`), no grace wording | alert-octagon |
| `grace` | `−1 ≥ d ≥ −5`, **DOT annual and PM only** | "Overdue {−d} day(s) · {5+d} days grace left" (d=−5 → "last grace day") | red | alert |
| `now` | `d ≤ −6`, DOT annual and PM only | "Due now — overdue {−d} days" | strongest red: solid fill, bold, pulsing border (respects `prefers-reduced-motion`) | alert-octagon |

- **Grace applies only to DOT annual and PM (Taylor item 9).** Insurance, registration, IRP and plate are legal expiries: from the day after, they show **"EXPIRED {n} days"** in strongest red, with no grace wording. Pre-due stages (`ok`/`soon`/`near`/`today`) are the same for all kinds.
- **One shared helper:** `dueStage({ kind, date, milesLeft, today }) → { stage, daysLeft, milesLeft, label, tone }` in `app/lib/maintenance.js` is a pure function with no I/O. `kind` selects grace vs. expiry rules. A null, empty or **invalid** date (e.g. `'2026-02-30'`, unparsable) gives `none` for the date part. `milesLeft` is accepted now for v2 PM mileage. When both are present, the result is the **worst of** the date stage and the mileage stage (mileage thresholds are v2 constants; ignored when null). Vehicle list badges, the "worst badge" sort (`now = expired > grace > today > near > soon > ok > none`), detail pages and the future v2 reminders all use it. The thresholds are named constants (`SOON_DAYS = 30`, `NEAR_DAYS = 14`, `GRACE_DAYS = 5`).
- **Date-only, user's local day:** due dates are Postgres `date` values (no time). `today` is the user's **local calendar date** (`new Date()` → local Y/M/D, the same approach as the existing `todayISO()`), never UTC. Both are converted to day numbers with `Date.UTC(y, m-1, d) / 86400000` before subtracting, so DST shifts and time of day can't move a boundary. The countdown re-renders when the local date changes (a check on focus and visibility change, plus a timer at the next local midnight).
- **Accessible:** color is never the only signal. Each stage has distinct text and an icon, and the badge carries `aria-label` with the full label. Yellow and orange use dark text (#1f2937) on the fill, and red/strong red use white text, all meeting WCAG AA 4.5:1. On buttons (e.g. "Log DOT inspection"), the same tone is applied to the border and an icon.
- Built mobile-first with the bottom tab bar, 44 px targets and the `DataState` loading/empty/error states. Amounts show two decimals.

### 6.2 Vehicle status: active / out of service / sold (decision: Marc, Oct 11)

Applies to trucks and trailers alike.

| Status | Default lists & unit pickers | History | Due badges | Editable | Tag |
|---|---|---|---|---|---|
| `active` | shown | full | shown | yes | — |
| `out_of_service` | **shown** (fully visible) | full | **shown**, still counting down | yes | automatic **"Out of Service"** tag, derived from `status` (never stored separately), grey with an icon and text |
| `sold` | **hidden**; only in the **Archive** view | **read-only** | hidden (not computed) | no; only "Restore" | "Sold {sold_at}" in the Archive |

- **Archive view:** `/maintenance?view=archive` (an "Archive (N)" link under the list) lists sold trucks and trailers. Opening one shows its details and history read-only: no add or edit of records, and no document upload.
- **Mark as sold:** a "Mark as sold" action asks for the sale date (default today, local), then sets `status='sold'` and `sold_at`. **Restore** sets `status='active'` and clears `sold_at`. If an active unit now uses the same unit number, Restore asks for a new number (the partial unique index enforces this).
- **Enforcement:** the RPC rejects saving or deleting service records on a sold vehicle (`22023 vehicle is sold`). Pickers query `status <> 'sold'`, so the "Load (optional)" picker is unaffected.
- **Archive immediately on sale:** marking a unit sold moves it to the Archive right away.
- **Retention (final, Marc, Oct 11):** sold-vehicle maintenance records and documents are kept **1 year after `sold_at`**. Basis: FMCSA [49 CFR 396.3(c)](https://www.law.cornell.edu/cfr/text/49/396.3) requires keeping them 1 year where the vehicle is housed or maintained, and **6 months after it leaves the carrier's control**, so 1 year after the sale covers that. **v1 never auto-deletes.**
- **Delete after 1 year (user's choice):** after `sold_at + 1 year` the Archive shows **"Delete vehicle & maintenance records"**. Before that the button is disabled with "Can be deleted after {date}", and the **server enforces** it: `delete_archived_vehicle(p_kind text, p_id uuid)` (security definer, §3) raises `42501` unless `status = 'sold' and sold_at <= current_date - interval '1 year'`. Direct client `delete` on `trucks`/`trailers` is **revoked**, so the RPC is the only path. Active and out-of-service vehicles can't be deleted (they must be sold first).
- **Export first, strongly prompted:** the delete screen leads with export. **"Export records (ZIP)" is the primary (filled) button**, and "Delete" is a secondary, red outline button that stays disabled until the user **types the unit number**. The export is a ZIP of the vehicle's documents (service-record pages + vehicle docs) plus `service_history.csv` and a printable `service_history.pdf` (VIN, make, year, unit snapshot, dates, types, vendors, totals, odometer/hours), built client-side from signed URLs. If the user hasn't exported in this session, a reminder shows above the field: "You haven't exported these records yet." The screen also states: *"Expense records may be needed for taxes (the IRS generally expects about 3 years). Your expense lines for this vehicle are **kept regardless**: only the maintenance records and their documents are deleted. Receipts attached to expenses are kept."*
- **What deletion removes vs. keeps (IRS safeguard: expenses are kept ~3 years):**
  - **Removed:** the vehicle row, its `service_records`, and its maintenance documents (service-record pages and vehicle docs) plus their storage objects. Their paths go into `storage_delete_queue` inside the RPC (§5).
  - **Kept: every expense row**, never deleted by this RPC. Before removing the records, the RPC unlinks them: it sets the guard flag, rewrites each linked expense's description to a permanent snapshot (`"Truck #12 (VIN …8834, sold 2026-03-03) · oil · Joe's Diesel"`), and the record deletion drops the only link (`service_records.expense_id`). `expenses` has no vehicle FK, so nothing else points at the vehicle. If one is ever added, it must be `on delete set null`. Amounts, dates, categories and load links are unchanged, so reports and taxes are unaffected.
  - **Kept: receipts attached to expenses.** Any document that is some expense's `document_id` is **not deleted**. The RPC only clears its `truck_id`/`trailer_id`/`service_record_id` (and the first-page doc of each record stays as that expense's receipt).
  - **Order inside the RPC (one transaction):** (1) lock the vehicle and check owner, sold status and the 1-year rule; (2) rewrite the linked expenses' descriptions (guard flag on); (3) **protect receipts**: clear `service_record_id`/`page_order`/`truck_id`/`trailer_id` on every doc any expense uses as `document_id`; (4) queue and delete the remaining record pages and vehicle docs; (5) delete the `service_records` (expenses are never deleted here); (6) delete the vehicle. The vehicle FKs are `on delete no action`, so a stray reference fails the transaction instead of cascading.
- **Reports:** expenses from sold vehicles' service records **still count** in the dashboard, Expenses and per-load totals. Those sum `expenses`, which status never touches. Expense lines keep their "From service record" link, which opens the archived read-only record.

### 6.3 Unit number reuse (confirmed: Marc, Oct 11)

Reusing a unit number is common after a wreck, sale or replacement, and the app allows it. A number only has to be unique among the user's **non-sold** vehicles.

**Research (Oct 11, 2026): no federal rule forbids reuse, but the VIN must be kept with the records, and some IRP states restrict it.**
- **FMCSA marking, [49 CFR 390.21](https://www.law.cornell.edu/cfr/text/49/390.21):** requires the carrier's name and USDOT number on the power unit. Unit numbers aren't required ("other identifying information may be displayed"), so there's no reuse rule.
- **Maintenance records, [49 CFR 396.3(b)(1)](https://www.law.cornell.edu/cfr/text/49/396.3):** records must identify the vehicle by "company number, if so marked, make, serial number, and year", plus who furnished it if it isn't carrier-owned. The serial number (VIN) is the durable identifier, and the unit number alone isn't enough. → **Requirement:** every service record shows and exports the vehicle's VIN, make, year and unit number. Because a vehicle's unit number can change, the **record stores a snapshot** of `unit_number`, `vin`, `make`, `model` and `year` at save time (`service_records.vehicle_snapshot jsonb`, set by `save_service_record`), and the FK still points at the live vehicle.
- **ELD, [49 CFR 395.26](https://www.law.cornell.edu/cfr/text/49/395.26) + [Appendix A §7.4/7.5](https://eld-federal-requirements.readthedocs.io/en/master/7-data_elements_dictionary.html):** ELDs record "vehicle identification data". The "CMV Power Unit Number" is the carrier's own business identifier (1–10 characters, set by the carrier or driver), and the VIN, read from the ECM, is what "uniquely identifies the operated CMV". Reuse is allowed, but the ELD's unit-to-VIN mapping must be updated when a number moves to a new truck.
- **IRP (apportioned plates / cab cards):** this is the one real restriction. Some base jurisdictions **don't allow a unit number to be reused within the same registration year** ([Illinois IRP instructions](https://www.ilsos.gov/publications/pdf_publications/cft_irp25_2025.pdf): "Unit numbers cannot be duplicated or reused during a registration year"). On a plate transfer, the added unit's number can't match the deleted unit's ([DC IRP manual](https://dmv.dc.gov/sites/default/files/dc/sites/dmv/publication/attachments/DC_IRP_Motor_Carrier_Manual_Nov2024.pdf)). Others require a unique number per listed vehicle ([Arizona](https://apps.azdot.gov/files/mvd/mvd-forms-lib/99-0149.pdf)), and transfers list both the old and new unit number plus VIN ([Wisconsin MV2914](https://wisconsindot.gov/Documents/formdocs/mv2914.pdf)). → The app warns about this but doesn't block it, because rules vary by base state.
- **IFTA, PrePass, insurance:** I found no federal or industry rule against reuse. These are account setups keyed to the VIN and plate: PrePass has a truck-transfer form with the new truck number, VIN and registration, and insurance schedules list units by VIN. They just need updating.

**UI: reminder checklist.** When saving a truck or trailer whose unit number **matches an archived (sold) unit**, or when **renumbering** an existing unit, a sheet shows "Unit #12 was used by a sold truck (VIN …8834, sold Mar 3). Update these so the old and new #12 don't get mixed up". The checklist items are tickable for the user's reference only and aren't stored in v1:
- ELD unit number ↔ VIN
- PrePass / Drivewyze / other bypass transponder
- Insurance schedule (remove the old VIN, add the new one)
- Fuel cards tied to unit number
- IRP cab card / plate transfer and IFTA. Includes the warning: *"Some states (e.g. IL) don't allow reusing a unit number in the same IRP registration year. Check with your base state."*
- Toll transponders (E-ZPass, PrePass Plus, BestPass)
- Factoring, broker and shipper setups, and load board equipment profiles
- Trailer-specific items: reefer telematics and trailer tracking

It shows once per save, can be dismissed, and never blocks saving.

**History displays VIN with the unit number.** Everywhere a vehicle appears in maintenance (lists, pickers, the history timeline, the Archive, expense descriptions and exports), the label is `#12 · …8834` (unit + last 4 of VIN, full VIN on the detail page). Each service record shows its snapshot, so the old #12's records still show the old VIN. When two vehicles share a unit number (one sold), the Archive and the "From service record" links show the VIN and `sold_at`, so they can't be confused. Because §396.3(b)(1) lists the serial number, a missing VIN on a truck or trailer shows a non-blocking "Add VIN, needed on maintenance records" prompt.

## 7. Scanner and extraction

- v1 uses Alex's scanner for capture and upload only. It does **not** call `/api/extract`, so there's no `extraction_runs` change in v1.
- **Multi-page extraction (v2): one extraction run per service record over all its pages (in `page_order`), counted once against the receipt limit (30/day, 150/month).** *Why:* invoice data spans pages (line items on page 1, total and tax on page 2/3), so per-page runs would return partial or conflicting totals and need a merge step. They would also burn up to 10× the limit for one bill. The run claims one slot with `p_kind = 'maintenance_invoice'`, which shares the receipt counters, and sends **the first 10 pages in `page_order`** across all of the record's documents (images downscaled, PDF pages rasterized) in one model call. A record can hold more (10 files × up to 20 PDF pages), so **the UI says so clearly**: "Auto-fill reads the first 10 pages. Put the invoice summary/total first." The reorder control is right there. If it fails, the slot is refunded, as today.
- v2 OCR prefill adds `DOC_TYPES.maintenance_invoice` (vendor, date, odometer, line items, total) in `app/lib/ai-extract.js`, adds `'maintenance_invoice'` to `extraction_runs_kind_check` (`0730`), and adds a limit branch in `claim_extraction_slot`.

## 8. Migrations (numbered after `20261010000730_extraction_runs_kind.sql`)

| # | File | Contents | Rollback |
|---|---|---|---|
| 1 | `20261012000800_trucks_extend.sql` | **no create, no renames**; `add column if not exists` for only the §2.1 columns; checks `not valid`; §1.1 defensive defaults, FK, trigger, RLS and indexes | drop added columns and constraints (only the ones we added) |
| 2 | `20261012000810_trailers_extend.sql` | **no create**: `add column if not exists` for §2.2; checks `not valid`; indexes `if not exists`; add the `user_id` default/FK and the `updated_at` trigger only if missing; RLS untouched | drop only the columns, constraints and indexes we added (never the table) |
| 3 | `20261012000820_documents_vehicle_fks.sql` | `documents.truck_id` (existing) FK to trucks `not valid`, **validated only if the orphan pre-check finds none** (else left `not valid` and reported); add `documents.trailer_id` + FK to trailers + the at-most-one check; grants; insert/update policies add the truck and trailer ownership checks | drop the FKs and `trailer_id`; restore the `0710`/`0400` policies |
| 4 | `20261012000830_service_records.sql` | table (**including `vehicle_snapshot`**), constraints, indexes, explicit RLS policies, grants; `storage_delete_queue`; `documents.service_record_id` + `page_order` + unique index; documents policies add the record ownership check | drop the documents columns, then `drop table service_records` |
| 5 | `20261012000840_service_record_rpcs.sql` | `save_service_record` (truck or trailer), `delete_service_record`, `delete_archived_vehicle` (1-year rule; keeps expenses and receipts), all `security definer` with `search_path` and `revoke … from public, anon`; revoke client `delete` on trucks/trailers; the linked-expense guard trigger on `expenses` (allows cascades) | drop functions and trigger |

### 8.1 Re-runnable migrations (Taylor item 8)

- Each file is wrapped in **`begin; … commit;`**, so it applies fully or not at all.
- Every `add constraint`, `create trigger` and `create policy` sits in a `do $$ begin if not exists (select 1 from pg_constraint / pg_trigger / pg_policies where …) then … end if; end $$;` guard. Columns use `add column if not exists`, and indexes use `create index if not exists`.
- **Order inside 0800/0810:** the policy scan (raise on broad policies) comes first, then `add column if not exists status …` and `sold_at`, then checks, then the partial unique index `… where status <> 'sold'` that depends on `status`.
- `vehicle_snapshot` is in the 0830 `create table`, not a later `alter`.
- Each file has a commented rollback block. Marc runs them in the SQL editor after Taylor re-reviews.

**Pre-check: one read-only query Marc can paste** (run before the migrations; the build PR includes its output):

```sql
-- READ-ONLY PRE-CHECK (one statement)
select 'policy' as check, tablename as obj, policyname || ' ' || cmd || ' roles=' || roles::text
         || ' using=' || coalesce(qual,'') || ' check=' || coalesce(with_check,'') as detail
  from pg_policies where schemaname = 'public' and tablename in ('trucks','trailers','documents')
union all
select 'orphan documents.truck_id', d.id::text, d.truck_id::text
  from public.documents d
 where d.truck_id is not null and not exists (select 1 from public.trucks t where t.id = d.truck_id)
union all
select 'dup unit_number', 'trucks', user_id || ' ' || unit_number
  from public.trucks group by user_id, unit_number having count(*) > 1
union all
select 'dup unit_number', 'trailers', user_id || ' ' || unit_number
  from public.trailers group by user_id, unit_number having count(*) > 1
union all
select 'column default/null', table_name, column_name || ' default=' || coalesce(column_default,'NULL') || ' nullable=' || is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name in ('trucks','trailers') and column_name in ('id','user_id','created_at','updated_at')
union all
select 'trigger', event_object_table, trigger_name
  from information_schema.triggers where event_object_schema = 'public' and event_object_table in ('trucks','trailers')
union all
select 'fk on delete', conrelid::regclass::text, conname || ' ' || pg_get_constraintdef(oid)
  from pg_constraint
 where contype = 'f' and conrelid = 'public.expenses'::regclass
   and pg_get_constraintdef(oid) ilike '%(document_id)%'
union all
select 'rls enabled', relname, relrowsecurity::text
  from pg_class where relnamespace = 'public'::regnamespace and relname in ('trucks','trailers','documents');
```

Any `orphan documents.truck_id` rows mean the FK stays `not valid` and the rows are reported (item 7). Any `dup unit_number` rows mean the unique index is skipped and reported. Any policy that isn't own-rows will make the migration raise. The `fk on delete` row shows the `expenses.document_id` action (Taylor R6). If it's `cascade`, a receipt delete would remove the expense, so the build flags it. If there's no FK, none is added in v1, and the cleanup re-check (§5.1) protects receipts.

## 9. PR breakdown (in order; each small and reversible; starts after Alex's scanner merges)

1. **docs:** this design.
2. **db: trucks extend + trailers extend** (migrations 1–2). Rollback: SQL above.
3. **app: vehicles list and add/edit for trucks and trailers** (`/maintenance`, `app/lib/maintenance.js` with presets and `dueStage`), plus due badges. Rollback: revert; tables stay harmless.
4. **db: documents truck/trailer FKs + service_records + RPCs** (migrations 3–5). Rollback: SQL above.
5. **app: add/edit/delete service record** through the RPCs, with scanner upload and document link, and the expense created or linked. The Expenses page shows linked rows read-only. Rollback: revert.
6. **app: per-vehicle history timeline** page. Rollback: revert.
7. **ops: storage cleanup job** (Marc or Alex, in the Supabase dashboard):
   1. Enable the **pg_cron** and **pg_net** extensions (Database → Extensions).
   2. Deploy the `maintenance-storage-cleanup` edge function (`supabase functions deploy`), and set its secrets: `SUPABASE_SERVICE_ROLE_KEY` (function secrets only) and `CLEANUP_SECRET`.
   3. Store the same `CLEANUP_SECRET` in **Vault** (`select vault.create_secret('…', 'cleanup_secret')`).
   4. Schedule the daily job with `cron.schedule('maintenance-storage-cleanup', '15 10 * * *', $$ select net.http_post(url := '<function url>', headers := jsonb_build_object('x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cleanup_secret'))) $$)`.
   5. Verify with one manual run and check the function log. Rollback: `cron.unschedule('maintenance-storage-cleanup')`.

## 10. Test plan

- **Isolation** (user A vs. B, SQL with `request.jwt.claims` plus API checks): B can't select, update or delete A's trucks, trailers or service records. B can't create a service record pointing at A's truck, trailer, document or expense. B can't set `documents.truck_id` / `trailer_id` to A's truck or trailer. The RPCs reject foreign ids.
- **Taylor fixes:**
  - **Definer RPCs:** an `authenticated` user can save, delete and archive-delete. `anon` gets permission denied on execute. User B passing A's vehicle, load, doc, expense or record id gets `42501`. `search_path` is pinned (`proconfig` check).
  - **Receipt survives:** `delete_service_record(keep_expense => true)` on a 3-page record keeps the expense **and** its page-1 receipt document (now unlinked from the record), and queues pages 2–3. With `keep_expense => false`, the expense is deleted and the receipt is queued.
  - **Account delete:** deleting a user who has records, linked expenses, pages and vehicle docs succeeds (§3.1).
  - **Policies:** a migration run against a DB with a broad `using (true)` policy on `trucks` raises and changes nothing.
  - **Idempotent save:** sending the same payload (same `id`) twice gives 1 record and 1 expense. A double-tap during a slow network does too.
  - **Link existing expense:** a `fuel` expense without the convert confirm is rejected, and with it becomes `maintenance`. Amount and date are overwritten and the diff is shown. An existing receipt `document_id` isn't replaced. Unlink leaves values unchanged.
  - **FK pre-check:** with an orphan `documents.truck_id`, migration 0820 leaves the FK `not valid` and reports. With none, it validates.
  - **Re-run:** running every migration twice succeeds with no changes on the second run, and a failure mid-file rolls the whole file back.
  - **Reorder:** swapping pages 1↔2 and moving 3→1 in one save succeeds (deferred unique). A 21-page PDF is rejected.
  - **Storage queue:** after a delete, paths are in `storage_delete_queue`. The client drains them, and the sweep retries a failed one.
  - **Queue on account delete (R2):** deleting a user with queued paths keeps those queue rows (no FK). The next sweep deletes the files and then the rows. User B can't select or delete A's queue rows, and no client can insert.
  - **Cleanup job (R1):** a call without or with a wrong `x-cleanup-secret` gets 401. A queued `/vehicles/` path, rate con or receipt is skipped. A path whose doc was re-linked before the run isn't deleted. An owner mismatch is dropped and not deleted. A missing file removes the row. After 10 failures it stops retrying. Two concurrent runs never process the same row. A second run is a no-op. The repo is grepped for the service role key: none found.
  - **Policy check (R4):** re-running 0820/0830 passes with their own `user_id = (select auth.uid()) and exists(…)` policies. A `using (true)` or `… or true` policy still raises.
  - **Extraction cap (R3, v2):** a record with 3 PDFs of 6 pages each sends pages 1–10 in `page_order`, and the UI note is shown.
  - **Documents page:** see §2.4 (PR 5 regression).
- **Multiple documents:** attach 3 pages and reorder (page_order 1–3 persists); remove one (unlinked and its file deleted); an 11th file is rejected by the UI and the RPC; a file over 10 MB is rejected; attaching user B's doc or a doc already on another record fails; a direct client update of `service_record_id` is denied; deleting a record cascades its document rows and the RPC returns the file paths; camera multi-capture on iPhone and Android; a multi-page PDF counts as one document.
- **Multi-page extraction (v2):** a 3-page invoice uses exactly one slot and one run, and its totals come from the last page; a failure refunds the slot.
- **Vehicle status:** an out-of-service unit appears in the list and pickers with the "Out of Service" tag, and its due badges still escalate. Marking a unit sold moves it to the Archive, hides it from pickers and makes its history read-only, while `sold_at` is required. The RPC rejects records on a sold unit. Restore returns the unit, prompting for a new number if it conflicts with an active unit. A unit number can be reused after a sale. Deleting a sold vehicle before `sold_at + 1 year` fails (RPC and direct `delete`, which is revoked); after 1 year it succeeds, removes the records and maintenance docs, **keeps every linked expense** (description rewritten with the VIN/unit snapshot, totals unchanged) and **keeps receipts** that are an expense's `document_id`; the export ZIP has all docs + CSV/PDF. Deleting an active or out-of-service vehicle fails. Dashboard and Expenses totals are unchanged after marking a unit sold.
- **Vehicle documents:** upload a title to a truck and a registration to a trailer; they appear in the Documents tab and the vault, at `{uid}/vehicles/{truck|trailer}/{id}/...`. A doc with both `truck_id` and `trailer_id` fails. Linking to user B's vehicle fails. View and delete work, and delete removes the storage object. For a sold unit the docs are read-only in the Archive and editable again after Restore. Rate cons and receipts are unaffected.
- **Unit reuse:** creating a unit with a sold unit's number shows the checklist (including the IRP warning) and saves. Renumbering shows it too. Service records keep the old snapshot (VIN and unit) after renumbering. Labels show `#unit · …VIN4`. A missing VIN shows the prompt but doesn't block.
- **Constraints:** a record with both or neither of truck/trailer fails (direct and via the RPC). Moving a record from a truck to a trailer clears `truck_id`. A trailer with records can't be deleted directly (only via `delete_archived_vehicle`). Migration 2 runs cleanly on Marc's existing trailer rows and leaves his RLS policies unchanged. Bad VIN, negative amounts, and a duplicate unit number per user all fail.
- **No double counting:**
  - Create a $500 record. Exactly one maintenance expense of $500 exists, and the dashboard's weekly maintenance total and expenseTotal go up by $500, not $1,000.
  - Edit the total to $450 and change the date. The expense follows and the dashboard reflects it.
  - Delete the record. The expense is gone. For a linked existing expense, unlink keeps it.
  - Editing or deleting a linked expense directly fails.
  - A record with 3 pages creates one expense whose `document_id` is page 1.
  - A charged-to-load record shows once in that load's net (`LoadExpenses`). Clearing the load removes it from that load.
  - A $0 warranty record creates one $0.00 expense line, shows "No charge", and leaves totals unchanged.
  - The RPC rejects a `load_id` owned by another user.
  - Force an error mid-RPC: no orphan record or expense.
- **Due stages:** expiry kinds at `d = −1` show "EXPIRED 1 day" (no grace), and at `−6` show "EXPIRED 6 days". DOT at `−1` shows grace. `dueStage({date: null})`, `''` and `'2026-02-30'` give `none`. Worst-of: the date `ok` with `milesLeft` past due gives the mileage stage. **Feb 29, 2028 + 12 months gives Feb 28, 2029** (the DOT suggestion clamps to month end). Unit tests for `dueStage` at `d = 31` (ok), `30` (soon), `15` (soon), `14` (near), `1` (near, "Due tomorrow"), `0` (today), and, for DOT/PM: `−1` (grace, 4 days left), `−5` (grace, last day), `−6` (now); for expiry kinds: `−1`/`−6` (expired); and null (none). **Insurance on its expiry day (`d = 0`) shows "Due today"** (not expired). Also: a local-midnight rollover (11:59 PM → 12:00 AM local changes the stage), a DST transition day, a user in UTC−7 at 10 PM local (still "today" locally even though UTC is the next day), the worst-badge ordering, and a check that every stage has a unique label and icon (not color alone). The `dot_annual` record's +12 months suggestion, including Feb 29.
- **Engine hours:** saved on records and vehicles. The "bump vehicle reading" suggestion appears only when the new value is higher.
- **Trailers end to end:** add a reefer trailer, log a $300 reefer service with hours, see one expense "Trailer TR-12 · …", the doc at `{uid}/maintenance/trailer/{id}/…`, and a DOT badge on the trailer.
- **Scanner:** upload PDF, JPEG and HEIC from Android and iPhone through the shared menu. The files land at `{uid}/maintenance/{truck|trailer}/{id}/{batch}/...` with `doc_type='maintenance_invoice'`, links to the record, and opens via a signed URL. The Documents page's rate con list is unchanged.
- **Mobile:** forms at 360 px, 44 px targets, numeric keyboards for odometer, hours and amounts.
- **Regression:** rate con upload and extraction, receipt auto-fill, expenses CRUD, mileage and `rate_per_mile`, dashboard totals unchanged for weeks without service records, and the loads list.

## 10a. Later / ideas (not v1)

- **Auto-suggest a load from the receipt date** (expenses and service records), to be validated with testers before building:
  - Compare the receipt date with each load's first-pickup to last-delivery window, using **each stop's own time zone** for the stop dates (a 11 PM PT delivery is still that PT date).
  - **Suggest only when exactly one load matches.** If several match (overlapping loads), or the date falls between loads (deadhead days), show a **pick list** of nearby loads plus "No load", with nothing preselected.
  - **Never link without the user confirming** (a suggestion chip the user taps, not an auto-fill).
  - **Skip cancelled loads** (`status = 'cancelled'`).
  - The user can always remove the link or keep "No load".

## 11. Open questions for Marc

**All open questions resolved. Taylor's reviews (7ef60e5 items 1–13; 68e166c R1–R6) are addressed; ready for re-review.** Marc's decisions (Oct 11): trailers in v1, every service record creates an expense (including $0), optional load link, due-date stages (5-day grace for DOT/PM only; legal expiries show EXPIRED), multiple documents per record, vehicle status/archive, unit number reuse, vehicle documents, and 1-year sold retention with expenses kept. The schema is confirmed (§1). The remaining unknowns are verify-at-build checks (§1.1).
