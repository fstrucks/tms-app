# Truck & Trailer Maintenance v1 (M1): design

> **Status: DESIGN ONLY.** This PR adds no migrations or app code. Taylor reviews it first, then it **waits on Marc's schema confirmation** (§1) and his approval.
> The build starts **after Alex's scanner PR merges**. Core owner-operator fixes always take priority.
> Every SQL block below is **illustrative**, not a migration.
> Source spec: `/workspace/plans/maintenance-spec-v1.md` (Drew's spec, trimmed per Dakota on Oct 11).

## 0. Scope

**v1 (this doc)**
- Vehicles: **trucks and trailers from day one.** Extend the existing `trucks` table and the `trailers` table Marc created on Oct 11 (already live, RLS set). Both get odometer/engine hours (reefer unit hours on trailers) and due dates.
- `service_records`: date, odometer, engine hours, service type, free-text vendor, costs, and **multiple scanned documents / pages** (up to 10).
- Scanned maintenance docs go through Alex's scanner. v1 only stores and links them; there's **no OCR prefill**.
- Service costs flow into Expenses **exactly once**.
- Per-vehicle due dates (DOT annual, registration, IRP, plate) are shown with a staged countdown badge (§6.1: OK → Due soon → Due today → Overdue with 5-day grace → Due now). **v1 sends no alerts.**
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

## 1. Schema to confirm with Marc ⚠️

**`trailers`: confirmed (Marc, Oct 11).** Created in Supabase with RLS limited to own rows. Columns: `id uuid, user_id uuid, unit_number text, year integer, make text, model text, vin text, license_plate text, license_state text, trailer_type text, length_ft integer, notes text, created_at timestamptz, updated_at timestamptz`. We **do not recreate it**. v1 only adds the maintenance columns listed in §2.2.

**`trucks`: still unconfirmed.** What the repo shows today:
- There is **no `trucks` table in `supabase/migrations`** (and `trailers` was also created outside the repo). Any trucks table was created in prod outside the repo, like `loads`, `stops`, `expenses`, `mileage_entries` and `profiles` were.
- `documents.truck_id uuid` exists with **no FK** (`20261010000050_documents_table.sql`). It's client-insertable and updatable (`20261010000200_documents_update_rls.sql`). The app always sends `null` (`app/documents/page.js:215`, `app/expenses/page.js:378`).
- `loads.truck_id` exists. It's listed in the UPDATE grant in `20261010000600_mileage.sql:152`, but its type and FK are unknown.
- `mileage_entries` has **no `truck_id`** that the repo knows of. It's tied to vehicles only through `load_id`.

**Marc, please run this in the Supabase SQL editor and paste the output.** It still covers `trailers` so we can confirm its `user_id` default and FK, its policies and its `updated_at` trigger before we add columns:

```sql
-- 1. Columns of trucks / trailers (if they exist)
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name in ('trucks', 'trailers')
 order by table_name, ordinal_position;

-- 2. RLS policies on them
select tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename in ('trucks', 'trailers');

-- 3. RLS enabled? row counts?
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('trucks', 'trailers');
select (select count(*) from public.trucks) as trucks;  -- skip if the table doesn't exist

-- 4. Constraints / FKs touching trucks anywhere
select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid)
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and (conrelid::regclass::text in ('trucks', 'trailers')
        or pg_get_constraintdef(oid) ilike '%truck%');

-- 5. Every truck_id / trailer_id column and its type
select table_name, column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and column_name in ('truck_id', 'trailer_id');

-- 6. Triggers on trucks / trailers (updated_at?)
select event_object_table, trigger_name, action_statement
  from information_schema.triggers
 where event_object_schema = 'public' and event_object_table in ('trucks', 'trailers');

-- 7. Any doc_type check on documents
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.documents'::regclass and contype = 'c';
```

The trucks design below assumes nothing. It says **"add if missing"**, and the first migration uses `add column if not exists`. We'll rename the proposed columns to match his existing ones (for example, if he already has `unit` rather than `unit_number`) once we see the output. For consistency with `trailers`, the proposed truck plate columns are now `license_plate` / `license_state`.

## 2. Data model

### 2.1 `trucks`: extend with these columns if missing (PROPOSED)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk default gen_random_uuid() | if the table doesn't exist yet |
| user_id | uuid not null default auth.uid() references profiles(id) | owner key, same as `documents` |
| unit_number | text not null | unique per user |
| vin | text | `check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$')` (17 characters, no I/O/Q) |
| year | int | `check (year between 1980 and 2100)` |
| make, model | text | |
| license_plate, license_state | text | `license_state ~ '^[A-Z]{2}$'` (same names as `trailers`) |
| odometer, odometer_updated_at | int, timestamptz | current reading, `>= 0` |
| engine_hours, engine_hours_updated_at | numeric(10,1), timestamptz | `>= 0` |
| in_service_date | date | |
| status | text not null default 'active' | `check (status in ('active','out_of_service','sold'))` (§6.2) |
| sold_at | date | set when sold; `check ((status = 'sold') = (sold_at is not null))` `not valid` |
| dot_annual_due, registration_due, irp_due, plate_due | date | v1 due-date badges |
| notes | text | |
| created_at, updated_at | timestamptz | reuse `set_updated_at()` from `0400` |

Indexes: `unique (user_id, unit_number) where status <> 'sold'` (a sold unit's number can be reused: **confirmed by Marc, Oct 11**; see §6.3), `unique (user_id, vin) where vin is not null`, `(user_id, status)`. New checks are added `not valid` so existing rows don't block the migration.

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
- **RLS is left as Marc set it.** We only verify (query 2 in §1) that it's `user_id = auth.uid()` for all commands. If `user_id` has no `default auth.uid()` or no FK to `profiles`, the migration adds them (`not valid` FK), and the `updated_at` trigger is added only if query 6 shows none.

### 2.2a How a record points at a truck or a trailer (decision)

**Decision: two nullable FKs, `truck_id` and `trailer_id`, with `check (num_nonnulls(truck_id, trailer_id) = 1)`.** I rejected the `asset_type + asset_id` alternative because:
- **Real FKs.** Postgres can't put a foreign key on a polymorphic `asset_id`, so we'd lose referential integrity and `on delete restrict` (a trailer with history can't be deleted out from under its records). We'd need triggers to fake that.
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
  truck_id uuid references public.trucks(id) on delete restrict,
  trailer_id uuid references public.trailers(id) on delete restrict,
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
  expense_id uuid unique references public.expenses(id) on delete restrict,
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

- New `doc_type` values: `'maintenance_invoice'` and `'dot_inspection'` (service records), plus vehicle documents `'vehicle_title'`, `'vehicle_registration'`, `'vehicle_insurance'`, `'bill_of_sale'` and `'other_vehicle_doc'` (§2.5). There's no doc_type check constraint in the repo today (query 6 in §1 confirms prod). If Marc's schema has one, the migration extends it.
- **Approved (Marc, Oct 11): documents link directly to a truck or trailer**, with no service record needed. `documents.truck_id` **already exists** (uuid, no FK, client-insertable; `20261010000050`), and v1 adds an FK `not valid` to `trucks`. We add **`documents.trailer_id uuid`** (FK `not valid` to `trailers`). Both use `on delete restrict`, because vehicles aren't deleted, only sold (§6.2). A check `num_nonnulls(truck_id, trailer_id) <= 1` means a document belongs to at most one vehicle. `trailer_id` is added to the client insert/update column grants, with the ownership check in §4.
- `documents.truck_id` gets an FK `not valid` to `trucks`. The RPC sets each attached doc's `truck_id`/`trailer_id` to match the record's vehicle.
- **Multiple documents per record: decision is `documents.service_record_id` (FK) + `documents.page_order`, not a join table.**
  ```sql
  -- ILLUSTRATIVE (migration 0830)
  alter table public.documents
    add column service_record_id uuid references public.service_records(id) on delete cascade,
    add column page_order smallint check (page_order between 1 and 10);
  create unique index on public.documents (service_record_id, page_order) where service_record_id is not null;
  ```
  - *Why:* a scanned invoice page belongs to exactly one service record, and nothing in v1 shares a page between records. So the relationship is one-to-many, and a join table would add a third table plus its own RLS for no benefit. With the FK, ownership is one more `exists` in the documents policies (the record's `user_id = auth.uid()`, same shape as `load_id` in `0710`), and `on delete cascade` handles cleanup.
  - *Writes:* `service_record_id`/`page_order` are **not** in the client column grants. Only `save_service_record` sets them (security invoker, so RLS still applies), passing the ordered `document_ids`. The documents policies also require the record to be owned by the caller.
  - **Cap:** at most **10 documents per record** (enforced in the RPC and the UI). Each file uses the existing documents limits: 10 MB per file and the same allowed types as receipts (PDF, JPEG, PNG, HEIC → JPEG). A multi-page PDF counts as one document.
  - The synced expense's `document_id` points at the first page (`page_order = 1`), so the Expenses list still shows a thumbnail. The other pages are reached from the record.
- Upload goes through Alex's scanner component (shared upload menu, type/size checks, HEIC conversion). v1 only stores the files and links them.
- **Form attachments:** an "Add pages" button opens the shared menu. **Camera multi-capture** lets the user take page after page and tap Done, or the **file picker** allows multi-select (`multiple`). Pages show as a thumbnail strip with a page number, **drag/arrow reorder** and **remove (×)**, plus an "N/10" counter, and the add button disables at 10. Each file uploads immediately with its own progress and retry. Saving waits for pending uploads. Files removed or abandoned before saving are deleted from storage and `documents` by the client (best effort; a v2 sweep cleans orphans with no record that are older than 24 h).
- The Documents page (`app/documents/page.js`) currently lists rate cons. It should filter maintenance doc types out, or tab them, so the rate con flow is unchanged.

### 2.5 Vehicle documents (title, registration, insurance, bill of sale…)

- A document with `truck_id` or `trailer_id` set and **no `service_record_id`** is a **vehicle document**. Doc types are `vehicle_title`, `vehicle_registration`, `vehicle_insurance`, `bill_of_sale` and `other_vehicle_doc` (with `original_filename` as its label). The list lives in JS (`VEHICLE_DOC_TYPES` in `app/lib/maintenance.js`), and a DB check is only extended if Marc's schema has one (§1 query 7).
- **Storage path:** `{uid}/vehicles/{truck|trailer}/{vehicle_id}/{ts}-{safeName}`. The first segment is still `{uid}`, so the existing `documents_insert_own` rule and the bucket policies already allow it, with no storage policy change. Limits are the same as other documents (10 MB per file; PDF/JPEG/PNG/HEIC). Service-record pages keep their `{uid}/maintenance/...` path (§5).
- **RLS:** insert and update require that `truck_id`/`trailer_id`, when set, belong to the caller (`exists` on `trucks`/`trailers`). Select and delete stay `user_id = auth.uid()`. A vehicle doc can't be attached to a vehicle that's sold (UI check, plus the RPC for service records).
- **Documents tab** on `/maintenance/trucks/[id]` and `/maintenance/trailers/[id]` (tabs: Overview · History · **Documents**):
  - **Upload** goes through Alex's shared upload menu (camera or file). The user picks a type, which defaults to `other_vehicle_doc`.
  - **List** is grouped by type, newest first, with thumbnail, name, date and type. Service-record pages also appear in a collapsed "From service records" group that links to the record.
  - **View** opens a signed URL, same as today.
  - **Delete** asks for confirmation, then removes the row and the storage object. Service-record pages are removed from the record form, not here.
- **Sold vehicles:** documents stay attached and visible **read-only** in the Archive (no upload or delete). They fall under the §6.2 retention rule (at least 3 years after `sold_at`, no auto-delete in v1), and Restore makes them editable again. A `bill_of_sale` upload is suggested when marking a unit sold.
- **Alex's document vault:** the vault is the cross-cutting view of all documents. Vehicle docs are ordinary `documents` rows, so the vault lists them automatically. It can filter by vehicle (`truck_id`/`trailer_id`) and type, and its checklist can flag a missing registration or insurance per active vehicle. Its send picker can attach them (e.g. registration plus insurance for a broker or a DOT stop). The vehicle Documents tab and the vault share the same upload component and doc-type list, so nothing is duplicated. Exact vault UI and naming are Alex's call, and I'll coordinate with Alex before the build.

## 3. Costs flowing into Expenses (one source of truth)

**Decision: the `expenses` row is the money record, and `service_records.expense_id` (unique) links to it.** The dashboard (`app/lib/dashboard.js` `aggregate()`) and per-load totals (`app/components/LoadExpenses.js`) keep summing **only `expenses`**. Nothing ever sums `service_records.total` into those numbers, so nothing can be counted twice.

- **Decision (Marc, Oct 11): every service record ALWAYS creates an expense line**, for any maintenance on a truck or trailer, **including $0** (warranty or goodwill work), so it all shows up in reports. There is **no "don't add to expenses" option**.
- Each service record owns **exactly one** expense: category `maintenance`, amount = `total` (may be `0.00`), `expense_date` = `service_date`, description `"{Truck|Trailer} {unit} · {service type} · {vendor}"`, `document_id` = the record's first page (`page_order = 1`, or null if no docs), and `load_id` = the record's `load_id`.
- **Optional load (Marc, Oct 11: yes, optional).** `service_records.load_id` is nullable and defaults to none; most records won't have one. When set, it's copied to the synced expense's `load_id`, so the cost counts in that load's net (`LoadExpenses`). Clearing it clears the expense's `load_id` too.
- **$0 is allowed everywhere:** `service_records.total >= 0`, the existing `expenses_amount_nonneg` check from `0700` (`amount >= 0`), the RPC (rejects only null/negative/non-numeric totals) and the form (`min="0"`; the current Expenses validation `amount < 0` already accepts `0`). **`0700` does not block $0, so no migration change is needed.**
- **How $0 lines show in reports:** they are listed like any other line, shown as `$0.00` with a small "No charge" tag (and "Warranty" when the service note or type says so). They add nothing to totals but do count in the record and expense counts, and they appear in the vehicle's history and the Expenses list, so the work is still tracked.
- **No new columns on `expenses`.** We can tell an expense came from a service record with `exists (select 1 from service_records where expense_id = e.id)`. The expenses list shows a "From service record" tag and links to the record using that join (`expenses.select('..., service_records(id)')`).
- **Linking an existing expense:** if Marc already logged the shop bill as an expense, he can pick it as the record's expense instead of creating a new one. The `unique` on `expense_id` guarantees one-to-one.
- **Transactional writes through RPCs.** `security invoker`, so RLS applies, like `create_load_from_document` in `0450`:
  - `save_service_record(p jsonb) returns uuid` takes **either** `truck_id` or `trailer_id` (exactly one, else it raises `22023`), checks the caller owns that vehicle, inserts or updates the record, upserts its expense (amount, including `0`, date, description, document, load), takes an ordered `document_ids uuid[]` (0–10; each must be the caller's, maintenance `doc_type`, and not attached to another record), sets their `service_record_id`/`page_order` and unlinks any removed ones, checks the optional `load_id` is a load the caller owns (`exists` on `loads` with `user_id = auth.uid()`, else it raises `42501`), and syncs the document's `truck_id`/`trailer_id`, all in one transaction. Moving a record to another unit (truck to trailer or vice versa) clears the old FK. The optional "bump reading" / "set DOT due" confirmations are applied to whichever table the vehicle is in.
  - `delete_service_record(p_id uuid, p_keep_expense boolean default false)` deletes the record and, unless kept, its expense, in one transaction. The attached `documents` rows go via cascade. The RPC returns their `file_path`s so the client can remove the storage objects, and the orphan sweep catches failures. It works the same for truck and trailer records. The vehicle row is never touched. A linked pre-existing expense defaults to kept, and the UI asks which the user wants.
- **Guard against drift:** a trigger on `expenses` rejects `update`/`delete` of a linked expense unless `current_setting('app.service_record_sync', true) = 'on'`. The RPCs set that flag with `set_config(..., true)`, which is transaction-local. The Expenses page shows linked rows read-only with "Edit in Maintenance". The `on delete restrict` on `expense_id` is a second guard.
- **Existing constraints** in `0700` (`expenses_amount_nonneg`: `amount >= 0`, category list including `maintenance`, date present) are already satisfied, including for $0 records.

## 4. RLS (today's `user_id = auth.uid()` pattern)

| Table | select | insert / update | delete |
|---|---|---|---|
| trucks | `user_id = (select auth.uid())` | same, with check | same |
| trailers | **already set by Marc** (own rows only); verified, not replaced | — | — |
| service_records | own | own **and** the referenced truck *or* trailer (whichever is set), the optional load, document and expense all have `user_id = auth.uid()` (`exists` checks, like `0700`/`0710`) and `documents.doc_type` is a maintenance type | own |

- If Marc's existing `trucks` policies differ from the pattern, the migration **drops all non-ours and recreates them** (the `0600`/`0700` pattern), once he has reviewed the §1 output.
- `documents.truck_id` / `documents.trailer_id`: update `documents_insert_own` and `documents_update_own` to also require that each is null or owned by the user (`exists` against `trucks` / `trailers`), mirroring the `load_id` rule in `0710`.
- `service_records` writes are **RPC-only**: grant `select` + `delete` to clients, and keep `insert`/`update` inside the security-invoker RPCs (the RLS checks still apply). `user_id` and `expense_id` can't be changed directly.
- **Company accounts (PR #27):** later, `trucks`, `trailers` and `service_records` get `company_id`, with composite FKs to keep the vehicle, document and expense in the same company. A future vendors table gets `company_id` too. The cross-row `exists` checks become company checks, and the RPCs take the company from the vehicle.

## 5. Storage

Paths are `{uid}/maintenance/{truck|trailer}/{vehicle_id}/{batch_id}/{nn}-{ts}-{safeName}`, where `batch_id` is a client UUID per form session (the record id isn't known before the first save) and `nn` is the capture order. For example: `{uid}/maintenance/trailer/9f2c…/b71e…/02-1760300000-page.jpg`. Display order comes from `page_order`, not the path. The unit segment is only for browsing and cleanup; the DB FKs are authoritative. That already satisfies `documents_insert_own` (`split_part(file_path,'/',1) = uid`) and the bucket policies in `20261010000000_documents_bucket.sql`, so no storage policy changes are needed. Allowed types and the 10 MB limit are unchanged (`0000`, `0300`). After company accounts, these become `{company_id}/{uid}/maintenance/...`.

*Cost per mile (v2 note):* sum the vehicle's maintenance totals for the period and divide by its miles for that period. Odometer deltas from `service_records` or vehicle readings work for this, since `mileage_entries` has no `truck_id`. For trailers it's per hub mile if hub readings are entered, otherwise per load mile. There's nothing to build in v1.

## 6. Per-vehicle UI

- **`/maintenance`:** one vehicle list with a **Trucks / Trailers** segmented filter (default All). Each row shows a type icon, unit, trailer type (for trailers), status, current odometer and engine hours, and the worst due badge. "Add vehicle" asks Truck or Trailer first. Trailer add/edit writes to Marc's `trailers` table, using his column names.
- **Unit picker** in the service record form: a single searchable list grouped **Trucks** then **Trailers** (`T-101 · 2019 Freightliner`, `TR-12 · Reefer 53 ft`). Selecting a unit sets `truck_id` or `trailer_id`.
- **Load (optional)** picker in the same form, defaulting to **"No load"**, listing the user's loads (most recent first). Amount accepts `0.00` with the hint "Use $0 for warranty / no-charge work". Engine hours show for trucks and reefer trailers. The `irp` service and due field are hidden for trailers.
- **`/maintenance/trucks/[id]` and `/maintenance/trailers/[id]`:** vehicle details plus a **history timeline** of service records (newest first; date, type, vendor, total, odometer/hours, document link) and the due-date list.
- **Due badges:** see §6.1. v2 reminders reuse the same helper. **No notifications in v1.**

### 6.1 Due-date stages (decision: Marc, Oct 11)

Starting 30 days before the due date, a soft nudge shows a **live countdown** ("Due in 12 days"). The color escalates as the date gets close. After the due date there's a **5-day grace period**, and from day 6 past due the badge shows the strongest alert.

`d = dueDate − today` in whole days:

| Stage key | Days left `d` | Label (text is always shown) | Color / style | Icon |
|---|---|---|---|---|
| `none` | no date | "No date set" | neutral grey outline | — |
| `ok` | `d > 30` | "Due Mar 3" (date) | neutral, no fill | — |
| `soon` | `30 ≥ d ≥ 15` | "Due in {d} days" | yellow | clock |
| `near` | `14 ≥ d ≥ 1` | "Due in {d} days" / "Due tomorrow" (d=1) | orange | clock |
| `today` | `d = 0` | "Due today" | red | alert |
| `grace` | `−1 ≥ d ≥ −5` | "Overdue {−d} day(s) · {5+d} days grace left" (d=−5 → "last grace day") | red | alert |
| `now` | `d ≤ −6` | "Due now — overdue {−d} days" | strongest red: solid fill, bold, pulsing border (respects `prefers-reduced-motion`) | alert-octagon |

- **One shared helper:** `dueStage(dueDate, today) → { stage, daysLeft, label, tone }` in `app/lib/maintenance.js` is a pure function with no I/O. Vehicle list badges, the "worst badge" sort (`now > grace > today > near > soon > ok > none`), detail pages and the future v2 reminders all use it. The thresholds are named constants (`SOON_DAYS = 30`, `NEAR_DAYS = 14`, `GRACE_DAYS = 5`).
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
- **Retention:** records for sold vehicles are kept **at least 3 years** after `sold_at` (*proposed, pending Marc's confirmation*). Basis: FMCSA [49 CFR 396.3(c)](https://www.law.cornell.edu/cfr/text/49/396.3) requires maintenance records to be kept where the vehicle is housed or maintained for 1 year, and for 6 months after the vehicle leaves the carrier's control. The IRS generally expects about 3 years of expense records, so 3 years covers both with margin. **v1 never auto-deletes.** A vehicle with service records can't be deleted at all (`on delete restrict`, and the UI offers "Mark as sold" instead of Delete). Any purge policy is a later decision.
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
- **Multi-page extraction (v2): one extraction run per service record over all its pages (in `page_order`), counted once against the receipt limit (30/day, 150/month).** *Why:* invoice data spans pages (line items on page 1, total and tax on page 2/3), so per-page runs would return partial or conflicting totals and need a merge step. They would also burn up to 10× the limit for one bill. The run claims one slot with `p_kind = 'maintenance_invoice'`, which shares the receipt counters, and sends all pages (max 10, images downscaled, PDF pages rasterized) in one model call. If it fails, the slot is refunded, as today.
- v2 OCR prefill adds `DOC_TYPES.maintenance_invoice` (vendor, date, odometer, line items, total) in `app/lib/ai-extract.js`, adds `'maintenance_invoice'` to `extraction_runs_kind_check` (`0730`), and adds a limit branch in `claim_extraction_slot`.

## 8. Migrations (numbered after `20261010000730_extraction_runs_kind.sql`)

| # | File | Contents | Rollback |
|---|---|---|---|
| 1 | `20261012000800_trucks_extend.sql` | create `trucks` if missing; `add column if not exists` for §2.1; checks `not valid`; indexes; RLS reset; `updated_at` trigger | drop added columns and constraints (only the ones we added) |
| 2 | `20261012000810_trailers_extend.sql` | **no create**: `add column if not exists` for §2.2; checks `not valid`; indexes `if not exists`; add the `user_id` default/FK and the `updated_at` trigger only if missing; RLS untouched | drop only the columns, constraints and indexes we added (never the table) |
| 3 | `20261012000820_documents_vehicle_fks.sql` | `documents.truck_id` (existing) FK to trucks; add `documents.trailer_id` + FK to trailers (`not valid`, then validate) + the at-most-one check; grants; insert/update policies add the truck and trailer ownership checks | drop the FKs and `trailer_id`; restore the `0710`/`0400` policies |
| 4 | `20261012000830_service_records.sql` | table, constraints, indexes, RLS, grants; `documents.service_record_id` + `page_order` + unique index; documents policies add the record ownership check | drop the documents columns, then `drop table service_records` |
| 5 | `20261012000840_service_record_rpcs.sql` | `save_service_record` (truck or trailer), `delete_service_record`, the `vehicle_snapshot` column (§6.3), the linked-expense guard trigger on `expenses` | drop functions and trigger |

Each file is idempotent, like the existing ones, with a commented rollback block. Marc runs them in the SQL editor after Taylor reviews.

## 9. PR breakdown (in order; each small and reversible; starts after Alex's scanner merges)

1. **docs:** this design.
2. **db: trucks extend + trailers extend** (migrations 1–2). Rollback: SQL above.
3. **app: vehicles list and add/edit for trucks and trailers** (`/maintenance`, `app/lib/maintenance.js` with presets and `dueStage`), plus due badges. Rollback: revert; tables stay harmless.
4. **db: documents truck/trailer FKs + service_records + RPCs** (migrations 3–5). Rollback: SQL above.
5. **app: add/edit/delete service record** through the RPCs, with scanner upload and document link, and the expense created or linked. The Expenses page shows linked rows read-only. Rollback: revert.
6. **app: per-vehicle history timeline** page. Rollback: revert.

## 10. Test plan

- **Isolation** (user A vs. B, SQL with `request.jwt.claims` plus API checks): B can't select, update or delete A's trucks, trailers or service records. B can't create a service record pointing at A's truck, trailer, document or expense. B can't set `documents.truck_id` / `trailer_id` to A's truck or trailer. The RPCs reject foreign ids.
- **Multiple documents:** attach 3 pages and reorder (page_order 1–3 persists); remove one (unlinked and its file deleted); an 11th file is rejected by the UI and the RPC; a file over 10 MB is rejected; attaching user B's doc or a doc already on another record fails; a direct client update of `service_record_id` is denied; deleting a record cascades its document rows and the RPC returns the file paths; camera multi-capture on iPhone and Android; a multi-page PDF counts as one document.
- **Multi-page extraction (v2):** a 3-page invoice uses exactly one slot and one run, and its totals come from the last page; a failure refunds the slot.
- **Vehicle status:** an out-of-service unit appears in the list and pickers with the "Out of Service" tag, and its due badges still escalate. Marking a unit sold moves it to the Archive, hides it from pickers and makes its history read-only, while `sold_at` is required. The RPC rejects records on a sold unit. Restore returns the unit, prompting for a new number if it conflicts with an active unit. A unit number can be reused after a sale. Deleting a vehicle with records is blocked. Dashboard and Expenses totals are unchanged after marking a unit sold.
- **Vehicle documents:** upload a title to a truck and a registration to a trailer; they appear in the Documents tab and the vault, at `{uid}/vehicles/{truck|trailer}/{id}/...`. A doc with both `truck_id` and `trailer_id` fails. Linking to user B's vehicle fails. View and delete work, and delete removes the storage object. For a sold unit the docs are read-only in the Archive and editable again after Restore. Rate cons and receipts are unaffected.
- **Unit reuse:** creating a unit with a sold unit's number shows the checklist (including the IRP warning) and saves. Renumbering shows it too. Service records keep the old snapshot (VIN and unit) after renumbering. Labels show `#unit · …VIN4`. A missing VIN shows the prompt but doesn't block.
- **Constraints:** a record with both or neither of truck/trailer fails (direct and via the RPC). Moving a record from a truck to a trailer clears `truck_id`. A trailer with records can't be deleted. Migration 2 runs cleanly on Marc's existing trailer rows and leaves his RLS policies unchanged. Bad VIN, negative amounts, and a duplicate unit number per user all fail.
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
- **Due stages:** unit tests for `dueStage` at `d = 31` (ok), `30` (soon), `15` (soon), `14` (near), `1` (near, "Due tomorrow"), `0` (today), `−1` (grace, 4 days left), `−5` (grace, last day), `−6` (now), and null (none). Also: a local-midnight rollover (11:59 PM → 12:00 AM local changes the stage), a DST transition day, a user in UTC−7 at 10 PM local (still "today" locally even though UTC is the next day), the worst-badge ordering, and a check that every stage has a unique label and icon (not color alone). The `dot_annual` record's +12 months suggestion, including Feb 29.
- **Engine hours:** saved on records and vehicles. The "bump vehicle reading" suggestion appears only when the new value is higher.
- **Trailers end to end:** add a reefer trailer, log a $300 reefer service with hours, see one expense "Trailer TR-12 · …", the doc at `{uid}/maintenance/trailer/{id}/…`, and a DOT badge on the trailer.
- **Scanner:** upload PDF, JPEG and HEIC from Android and iPhone through the shared menu. The files land at `{uid}/maintenance/{truck|trailer}/{id}/{batch}/...` with `doc_type='maintenance_invoice'`, links to the record, and opens via a signed URL. The Documents page's rate con list is unchanged.
- **Mobile:** forms at 360 px, 44 px targets, numeric keyboards for odometer, hours and amounts.
- **Regression:** rate con upload and extraction, receipt auto-fill, expenses CRUD, mileage and `rate_per_mile`, dashboard totals unchanged for weeks without service records, and the loads list.

## 10a. Later / ideas (not v1)

- **Auto-suggest a load from the receipt date** (expenses and service records): when a receipt or service date is entered, suggest the load whose pickup–delivery dates cover that date. The user can remove the link or keep "No load". To be validated with testers before building.

## 11. Open questions for Marc
1. **Trucks schema (§1), still unconfirmed:** please paste the output. Which truck columns already exist, and what are they named? (Trailers are confirmed. The same output also confirms the trailers `user_id` default/FK and `updated_at` trigger.)
2. Retention for sold vehicles: is **3 years after `sold_at`** OK (§6.2; covers the FMCSA 18-month minimum and the IRS ~3 years)? Nothing is auto-deleted in v1 either way.
