# Truck Maintenance v1 (M1): design

> **Status: DESIGN ONLY.** This PR adds no migrations or app code. Taylor reviews it first, then it **waits on Marc's schema confirmation** (§1) and his approval.
> The build starts **after Alex's scanner PR merges**. Core owner-operator fixes always take priority.
> Every SQL block below is **illustrative**, not a migration.
> Source spec: `/workspace/plans/maintenance-spec-v1.md` (Drew's spec, trimmed per Dakota on Oct 11).

## 0. Scope

**v1 (this doc)**
- Vehicles: extend the existing `trucks` table and add `trailers`. Both include engine hours.
- `service_records`: date, odometer, engine hours, service type, free-text vendor, costs, and a linked scanned document.
- Scanned maintenance docs go through Alex's scanner. v1 only stores and links them; there's **no OCR prefill**.
- Service costs flow into Expenses **exactly once**.
- Per-vehicle due dates (DOT annual, registration, IRP, plate) are shown with an OK / Due soon / Overdue badge. **v1 sends no alerts.**
- A per-vehicle history page (timeline).

**v2: out of scope, but the design leaves room for it without rework**

| v2 feature | Hook left in v1 |
|---|---|
| PM schedules and alerts (miles / engine hours / days, whichever comes first), seeded with Drew's default intervals (PM A 25k mi / 500 hr / 6 mo, PM B 50k / 1,000 hr / 12 mo, etc., listed in the spec) | `service_records.service_type`, `odometer` and `engine_hours` are captured now. A later `pm_schedules (vehicle, service_type, interval_miles, interval_hours, interval_days)` table reads "last done" from `service_records`. The badge helper (§6) is reused. |
| Weekly odometer prompt | `trucks.odometer_updated_at` |
| OCR prefill | Add a `'maintenance_invoice'` entry to `DOC_TYPES` in `app/lib/ai-extract.js` and add the kind to `extraction_runs_kind_check` (§7). |
| Vendors | `service_records.vendor_name` is free text now. A nullable `vendor_id` and a backfill from distinct names come later. |
| CSV export and import, bulk PDF import | Plain columns now, so v2 needs no reshaping. |
| Tires | `service_type = 'tires'` records now. A `tires` table later, which can reference `service_records.id`. |
| Cost per mile and cost reports by type | `service_type`, `total`, `odometer` and the expense link are all in place (§5 note). |
| DOT inspection details (pass/fail, defects) | v1 keeps only the date on the vehicle plus a `dot_annual` service record with its scanned report. |

**Deferred:** parts inventory, work orders, ELD odometer sync, warranties.

**Constraint:** nothing about loads, expenses, mileage or the dashboard changes for Marc unless he adds a service record.

## 1. Schema to confirm with Marc ⚠️

This is what the repo shows about trucks today:
- There is **no `trucks` or `trailers` table in `supabase/migrations`**. Any trucks table was created in prod outside the repo, like `loads`, `stops`, `expenses`, `mileage_entries` and `profiles` were.
- `documents.truck_id uuid` exists with **no FK** (`20261010000050_documents_table.sql`). It's client-insertable and updatable (`20261010000200_documents_update_rls.sql`). The app always sends `null` (`app/documents/page.js:215`, `app/expenses/page.js:378`).
- `loads.truck_id` exists. It's listed in the UPDATE grant in `20261010000600_mileage.sql:152`, but its type and FK are unknown.
- `mileage_entries` has **no `truck_id`** that the repo knows of. It's tied to vehicles only through `load_id`.

**Marc, please run this in the Supabase SQL editor and paste the output:**

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

-- 6. Any doc_type check on documents
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.documents'::regclass and contype = 'c';
```

The design below assumes nothing. It says **"add if missing"**, and the first migration uses `add column if not exists`. We'll rename the proposed columns to match his existing ones (for example, if he already has `unit` rather than `unit_number`) once we see the output.

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
| plate_number, plate_state | text | `plate_state ~ '^[A-Z]{2}$'` |
| odometer, odometer_updated_at | int, timestamptz | current reading, `>= 0` |
| engine_hours, engine_hours_updated_at | numeric(10,1), timestamptz | `>= 0` |
| in_service_date | date | |
| status | text not null default 'active' | `check (status in ('active','out_of_service','sold'))` |
| dot_annual_due, registration_due, irp_due, plate_due | date | v1 due-date badges |
| notes | text | |
| created_at, updated_at | timestamptz | reuse `set_updated_at()` from `0400` |

Indexes: `unique (user_id, unit_number)`, `unique (user_id, vin) where vin is not null`, `(user_id, status)`. New checks are added `not valid` so existing rows don't block the migration.

### 2.2 `trailers` (NEW)

Same shape as trucks: `unit_number`, `vin`, `year`, `make`, `model`, plate fields, `trailer_type` (`'dry_van','reefer','flatbed','other'`), `engine_hours` (reefer unit hours; null for non-reefers), `odometer` (hub reading, optional), `status`, `dot_annual_due`, `registration_due`, `plate_due`, `in_service_date`, `notes` and timestamps. IRP applies to power units, so trailers have no `irp_due`. Indexes match trucks.

### 2.3 `service_records` (NEW)

```sql
-- ILLUSTRATIVE
create table public.service_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  truck_id uuid references public.trucks(id) on delete restrict,
  trailer_id uuid references public.trailers(id) on delete restrict,
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
  document_id uuid unique references public.documents(id) on delete set null,
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
- **One document per record** in v1 (`document_id unique`). Multiple attachments would need a join table in v2. That's an open question.
- Saving a `dot_annual` record offers to set the vehicle's `dot_annual_due` to `service_date + 12 months`. The user confirms; nothing is silently overwritten.
- Saving a record with a higher `odometer` or `engine_hours` than the vehicle's current value offers to bump the vehicle's reading.

### 2.4 Maintenance documents: reuse `documents`

- New `doc_type` values: `'maintenance_invoice'` and `'dot_inspection'`. There's no doc_type check constraint in the repo today (query 6 in §1 confirms prod). If Marc's schema has one, the migration extends it.
- `documents.truck_id` gets the truck when the vehicle is a truck. It's already client-insertable, and v1 adds an FK `not valid` to `trucks`. For trailers, documents have no `trailer_id`. The link is `service_records.document_id`, which is canonical for both vehicle types, so I'm not adding `documents.trailer_id` in v1.
- Upload goes through Alex's scanner component (shared upload menu, type/size checks, HEIC conversion). v1 only stores the file and links it.
- The Documents page (`app/documents/page.js`) currently lists rate cons. It should filter maintenance doc types out, or tab them, so the rate con flow is unchanged.

## 3. Costs flowing into Expenses (one source of truth)

**Decision: the `expenses` row is the money record, and `service_records.expense_id` (unique) links to it.** The dashboard (`app/lib/dashboard.js` `aggregate()`) and per-load totals (`app/components/LoadExpenses.js`) keep summing **only `expenses`**. Nothing ever sums `service_records.total` into those numbers, so nothing can be counted twice.

- Each service record owns **exactly one** expense: category `maintenance`, amount = `total`, `expense_date` = `service_date`, description `"{unit} · {service type} · {vendor}"`, `document_id` = the service record's document, and `load_id` null by default. The optional "charge to a load" picker sets it.
- **No new columns on `expenses`.** We can tell an expense came from a service record with `exists (select 1 from service_records where expense_id = e.id)`. The expenses list shows a "From service record" tag and links to the record using that join (`expenses.select('..., service_records(id)')`).
- **Linking an existing expense:** if Marc already logged the shop bill as an expense, he can pick it as the record's expense instead of creating a new one. The `unique` on `expense_id` guarantees one-to-one.
- **Transactional writes through RPCs.** `security invoker`, so RLS applies, like `create_load_from_document` in `0450`:
  - `save_service_record(p jsonb) returns uuid` inserts or updates the record and upserts its expense (amount, date, description, document, load) in one transaction.
  - `delete_service_record(p_id uuid, p_keep_expense boolean default false)` deletes the record and, unless kept, its expense, in one transaction. A linked pre-existing expense defaults to kept, and the UI asks which the user wants.
- **Guard against drift:** a trigger on `expenses` rejects `update`/`delete` of a linked expense unless `current_setting('app.service_record_sync', true) = 'on'`. The RPCs set that flag with `set_config(..., true)`, which is transaction-local. The Expenses page shows linked rows read-only with "Edit in Maintenance". The `on delete restrict` on `expense_id` is a second guard.
- **Existing constraints** in `0700` (`amount >= 0`, category list including `maintenance`, date present) are already satisfied.

## 4. RLS (today's `user_id = auth.uid()` pattern)

| Table | select | insert / update | delete |
|---|---|---|---|
| trucks, trailers | `user_id = (select auth.uid())` | same, with check | same |
| service_records | own | own **and** the referenced truck/trailer, document and expense all have `user_id = auth.uid()` (`exists` checks, like `0700`/`0710`) and `documents.doc_type` is a maintenance type | own |

- If Marc's existing `trucks` policies differ, the migration **drops all non-ours and recreates them** (the `0600`/`0700` pattern), once he has reviewed the §1 output.
- `documents.truck_id`: update `documents_insert_own` and `documents_update_own` to also require `truck_id is null or` the user owns that truck, mirroring the `load_id` rule in `0710`.
- `service_records` writes are **RPC-only**: grant `select` + `delete` to clients, and keep `insert`/`update` inside the security-invoker RPCs (the RLS checks still apply). `user_id` and `expense_id` can't be changed directly.
- **Company accounts (PR #27):** later, `trucks`, `trailers` and `service_records` get `company_id`, with composite FKs to keep the vehicle, document and expense in the same company. A future vendors table gets `company_id` too. The cross-row `exists` checks become company checks, and the RPCs take the company from the vehicle.

## 5. Storage

Paths are `{uid}/maintenance/{ts}-{safeName}`. That already satisfies `documents_insert_own` (`split_part(file_path,'/',1) = uid`) and the bucket policies in `20261010000000_documents_bucket.sql`, so no storage policy changes are needed. Allowed types and the 10 MB limit are unchanged (`0000`, `0300`). After company accounts, these become `{company_id}/{uid}/maintenance/...`.

*Cost per mile (v2 note):* sum the vehicle's maintenance totals for the period and divide by its miles for that period. Odometer deltas from `service_records` or vehicle readings work for this, since `mileage_entries` has no `truck_id`. There's nothing to build in v1.

## 6. Per-vehicle UI

- **`/maintenance`:** a vehicle list (trucks and trailers) with unit, status, current odometer and engine hours, and the worst due badge.
- **`/maintenance/trucks/[id]` and `/maintenance/trailers/[id]`:** vehicle details plus a **history timeline** of service records (newest first; date, type, vendor, total, odometer/hours, document link) and the due-date list.
- **Due badges:** a pure function in `app/lib/maintenance.js` returns `dueStatus(date, today)`: `overdue` if `date < today`, `due_soon` if within 30 days (open question), `ok` otherwise, or `none` if no date. v2 reminders reuse it. **No notifications in v1.**
- Built mobile-first with the bottom tab bar, 44 px targets and the `DataState` loading/empty/error states. Amounts show two decimals.

## 7. Scanner and extraction

- v1 uses Alex's scanner for capture and upload only. It does **not** call `/api/extract`, so there's no `extraction_runs` change in v1.
- v2 OCR prefill adds `DOC_TYPES.maintenance_invoice` (vendor, date, odometer, line items, total) in `app/lib/ai-extract.js`, adds `'maintenance_invoice'` to `extraction_runs_kind_check` (`0730`), and adds a limit branch in `claim_extraction_slot`.

## 8. Migrations (numbered after `20261010000730_extraction_runs_kind.sql`)

| # | File | Contents | Rollback |
|---|---|---|---|
| 1 | `20261012000800_trucks_extend.sql` | create `trucks` if missing; `add column if not exists` for §2.1; checks `not valid`; indexes; RLS reset; `updated_at` trigger | drop added columns and constraints (only the ones we added) |
| 2 | `20261012000810_trailers.sql` | `trailers` table, RLS, indexes | `drop table trailers` |
| 3 | `20261012000820_documents_truck_fk.sql` | `documents.truck_id` FK to trucks (`not valid`, then validate); insert/update policies add the truck ownership check | drop the FK; restore the `0710`/`0400` policies |
| 4 | `20261012000830_service_records.sql` | table, constraints, indexes, RLS, grants | `drop table service_records` |
| 5 | `20261012000840_service_record_rpcs.sql` | `save_service_record`, `delete_service_record`, the linked-expense guard trigger on `expenses` | drop functions and trigger |

Each file is idempotent, like the existing ones, with a commented rollback block. Marc runs them in the SQL editor after Taylor reviews.

## 9. PR breakdown (in order; each small and reversible; starts after Alex's scanner merges)

1. **docs:** this design.
2. **db: trucks extend + trailers** (migrations 1–2). Rollback: SQL above.
3. **app: vehicles list and add/edit** (`/maintenance`, `app/lib/maintenance.js` with presets and `dueStatus`), plus due badges. Rollback: revert; tables stay harmless.
4. **db: documents truck FK + service_records + RPCs** (migrations 3–5). Rollback: SQL above.
5. **app: add/edit/delete service record** through the RPCs, with scanner upload and document link, and the expense created or linked. The Expenses page shows linked rows read-only. Rollback: revert.
6. **app: per-vehicle history timeline** page. Rollback: revert.

## 10. Test plan

- **Isolation** (user A vs. B, SQL with `request.jwt.claims` plus API checks): B can't select, update or delete A's trucks, trailers or service records. B can't create a service record pointing at A's truck, document or expense. B can't set `documents.truck_id` to A's truck. The RPCs reject foreign ids.
- **Constraints:** a record with both or neither of truck/trailer fails. Bad VIN, negative amounts, and a duplicate unit number per user all fail.
- **No double counting:**
  - Create a $500 record. Exactly one maintenance expense of $500 exists, and the dashboard's weekly maintenance total and expenseTotal go up by $500, not $1,000.
  - Edit the total to $450 and change the date. The expense follows and the dashboard reflects it.
  - Delete the record. The expense is gone. For a linked existing expense, unlink keeps it.
  - Editing or deleting a linked expense directly fails.
  - A charged-to-load record shows once in that load's net (`LoadExpenses`).
  - Force an error mid-RPC: no orphan record or expense.
- **Due badges:** unit tests for `dueStatus` (past, today, today+30, today+31, null). The `dot_annual` record's +12 months suggestion, including Feb 29.
- **Engine hours:** saved on records and vehicles. The "bump vehicle reading" suggestion appears only when the new value is higher.
- **Scanner:** upload PDF, JPEG and HEIC from Android and iPhone through the shared menu. The file lands at `{uid}/maintenance/...` with `doc_type='maintenance_invoice'`, links to the record, and opens via a signed URL. The Documents page's rate con list is unchanged.
- **Mobile:** forms at 360 px, 44 px targets, numeric keyboards for odometer, hours and amounts.
- **Regression:** rate con upload and extraction, receipt auto-fill, expenses CRUD, mileage and `rate_per_mile`, dashboard totals unchanged for weeks without service records, and the loads list.

## 11. Open questions for Marc

1. **Schema (§1):** please paste the output. Which truck columns already exist, and what are they named?
2. Should service costs **always** go into Expenses, or is there a per-record "don't add to expenses" option (for example, warranty work at $0)?
3. Should maintenance ever be charged to a specific load (affecting that load's net), or always stay a general expense?
4. Due-soon window: is 30 days right for DOT, registration, IRP and plates?
5. Is one scanned document per service record enough, or do you need several (invoice plus inspection report)?
6. Which trailer types do you run (reefer? which would need engine hours)?
7. Should a sold or out-of-service vehicle's history stay visible?
