# Company accounts (multi-tenant / white-label) — design

> **Status: DESIGN ONLY.** No migrations or app code ship with this doc. Nothing is built until Marc approves. Reviewer: Taylor.
> **Priority rule:** core owner-operator bugs and fixes always come first. This work pauses whenever one comes up.
> All SQL below is **illustrative**: a sketch, not a migration.

## 0. What exists today (sources)

| Object | Owner key today | Source |
|---|---|---|
| `loads` | `user_id = auth.uid()` (select/insert/update/delete) | `20261010000400_loads.sql` (table pre-existed, from Marc) |
| `stops` | no `user_id`; owned **through** `loads` via `exists (... l.user_id = auth.uid())` | `20261010000400_loads.sql`; `timezone` col in `..0680_stops_timezone.sql` |
| `documents` | `user_id` (default `auth.uid()`); in **prod** `documents_user_id_fkey` → `public.profiles(id)` (repo says `auth.users`, documented drift) | `..0050`, `..0100`, `..0200`, `..0500`, `..0710` |
| documents column grants | INSERT only `(user_id, load_id, truck_id, doc_type, file_path, original_filename)`; UPDATE only `(load_id, truck_id, doc_type)`; `ai_extracted_data` server-only | `..0200_documents_update_rls.sql` |
| documents insert rule | `split_part(file_path,'/',1) = auth.uid()::text` and `load_id` null or own load | `..0100`, `..0710` |
| `expenses` | `user_id`; `load_id`/`document_id` must be own rows; NOT VALID checks | `..0700_expenses_rls.sql` |
| `mileage_entries` | `user_id`; `load_id` must be own load; triggers keep `loads.total_miles`/`rate_per_mile` (security definer) | `..0600_mileage.sql` |
| `extraction_runs` | `user_id`, `document_id`, `status`, `kind` (`rate_confirmation`/`receipt`); server writes only | `..0200`, `..0730` |
| `claim_extraction_slot(p_user, p_document, p_kind)` | per-**user** advisory lock; limits hard-coded: rate con 20/h 100/day, receipt 30/h 150/day; service_role only | `..0730_extraction_runs_kind.sql` |
| `create_load_from_document(p_document)` | security **invoker** RPC inserting `loads` + `stops` with `user_id` | `..0450_create_load_rpc.sql` |
| `profiles` + `on_auth_user_created` → `handle_new_user()` | inserts `profiles(id)` per new auth user | `..0500_profiles_on_signup.sql` (profiles table itself created in prod outside repo) |
| Storage bucket `documents` | private, 10 MB, `allowed_mime_types` pdf/jpeg/png/webp/heic/heif; policies `(storage.foldername(name))[1] = auth.uid()::text` for insert/select/delete | `..0000`, `..0300` |

App code that depends on the owner key:
- `app/lib/supabase.js` `getSupabase()` (anon client, RLS does all scoping; no explicit `user_id` filters on reads).
- `app/documents/page.js:203` and `app/expenses/page.js:374` build paths as `${user.id}/${Date.now()}-name`.
- `app/expenses/page.js:420`, `app/mileage/page.js:68`, `app/components/LoadMileage.js:41` insert `user_id: user.id` explicitly.
- `app/api/extract/route.js:83` rejects files not under `${user.id}/`; calls `claim_extraction_slot` (`:108`) and writes `ai_extracted_data` via service role.
- `app/api/extract-receipt/route.js:100` calls `claim_extraction_slot(..., p_kind: 'receipt')`.
- `app/dashboard/page.js` reads loads/stops/mileage/expenses and relies on RLS for scoping.
- Branding: `app/layout.js` (metadata `PowerHaul TMS`), `app/components/AppNav.js:48`, `app/page.js:47` — hard-coded.

## 1. Goals, non-goals, constraints

**Goals**
- A *company* (fleet of 1–50 trucks) owns all operational data; users are *members* with a role.
- Strict isolation between companies, enforced in Postgres (RLS + storage policies), not only in the UI.
- Per-company AI limits and per-company branding (white-label).
- FS Trucks is customer #1; Marc's existing data moves into it.

**Non-goals (this phase)**
- Billing/payments, custom domains, SSO, cross-company sharing, a super-admin UI, trucks/drivers tables (beyond the existing `documents.truck_id`), one user in multiple companies at once in the UI (the schema allows it; UI picks one).

**Hard constraint: zero behavior change for Marc.** Every step must leave his screens, data, uploads, extraction and dashboard numbers identical. Each step is reversible on its own.

## 2. Data model (all PROPOSED / new)

```sql
-- ILLUSTRATIVE
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  -- branding
  display_name text,            -- default 'PowerHaul TMS' when null
  logo_path text,               -- in a 'branding' bucket, {company_id}/logo.png
  primary_color text check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  support_email text,
  -- plan / limits
  plan text not null default 'standard',
  max_trucks int,               -- informational for now
  ai_rate_con_per_hour int not null default 20,
  ai_rate_con_per_day  int not null default 100,
  ai_receipt_per_hour  int not null default 30,
  ai_receipt_per_day   int not null default 150,
  created_at timestamptz not null default now()
);

create table public.company_members (
  company_id uuid not null references public.companies on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','dispatcher','driver','viewer')),
  status text not null default 'active' check (status in ('active','invited','disabled')),
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)          -- = unique (company_id, user_id)
);
create index on public.company_members (user_id) where status = 'active';

-- optional
create table public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies on delete cascade,
  email text not null,
  role text not null check (role in ('dispatcher','driver','viewer')),  -- owners not invitable directly
  token_hash text not null,
  invited_by uuid not null references public.profiles(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  unique (company_id, email)
);
```

`company_members.user_id` references `public.profiles(id)` to match prod's `documents_user_id_fkey`; `handle_new_user()` already guarantees a profile exists.

### Role permission matrix (proposed; R/I/U/D)

| Table | owner | dispatcher | driver | viewer |
|---|---|---|---|---|
| companies | R, U (branding) | R | R | R |
| company_members | R/I/U/D (anti-escalation rules) | R | R (self) | R (self) |
| loads | R/I/U/D | R/I/U/D | R (assigned only?*) , U status only? | R |
| stops | as load | as load | R (assigned loads) | R |
| documents | R/I/U/D | R/I/U/D | R/I own + assigned; U own | R |
| expenses | R/I/U/D | R/I/U/D | R/I/U/D **own** only | R |
| mileage_entries | R/I/U/D | R/I/U/D | R/I/U/D own only | R |
| extraction_runs | R | R | R own | — |

\* Driver visibility of loads needs a `loads.assigned_driver_id` (new) — **open question**. Until decided, drivers see only rows they created (`user_id = auth.uid()`), which is exactly today's behavior.

## 3. Adding `company_id`

New nullable column (later NOT NULL) on `loads`, `documents`, `expenses`, `mileage_entries`, `extraction_runs`:

```sql
-- ILLUSTRATIVE
alter table public.loads add column company_id uuid references public.companies(id);  -- on delete restrict
create index loads_company_created_idx on public.loads (company_id, created_at desc);
-- same pattern: documents(company_id, created_at), expenses(company_id, expense_date),
-- mileage_entries(company_id, entry_date), extraction_runs(company_id, kind, created_at desc)
```

Keep `user_id` everywhere as "created by" (audit + driver-own rules).

**Cross-company FK integrity:** child `load_id`/`document_id` must be in the same company. Use composite FKs: `unique (id, company_id)` on `loads`/`documents`, then `foreign key (load_id, company_id) references loads (id, company_id)`. This makes "moving rows across companies" structurally impossible. (Care: `documents_load_id_fkey` is `on delete set null`; a composite FK with `set null (load_id)` needs PG15+, otherwise keep the single-column FK plus a trigger check.)

**stops: derive vs. denormalize**

| Option | Pros | Cons |
|---|---|---|
| Derive via `load_id` (today's pattern) | No backfill, can't drift, `create_load_from_document` unchanged | Every stops policy does an `exists` join to loads; dashboard reads stops by date range (`app/dashboard/page.js:112`) |
| Add `stops.company_id` | Simple fast policies, direct index | Must be kept equal to the load's (composite FK or trigger) |

**Recommendation:** add `stops.company_id` filled by a `before insert` trigger from the load, with composite FK `(load_id, company_id) → loads(id, company_id)`. Dashboard date-range scans then use `(company_id, appointment_start)`. Fallback: stay derived if Taylor prefers fewer moving parts — fine at 1–50 trucks.

## 4. RLS rewrite

### Helpers

```sql
-- ILLUSTRATIVE
create function public.is_company_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from company_members
                  where company_id = cid and user_id = (select auth.uid()) and status = 'active');
$$;

create function public.has_company_role(cid uuid, roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from company_members
                  where company_id = cid and user_id = (select auth.uid())
                    and status = 'active' and role = any (roles));
$$;

create function public.current_company_id() returns uuid   -- the user's single active membership (transition helper)
language sql stable security definer set search_path = public as $$
  select company_id from company_members
   where user_id = (select auth.uid()) and status = 'active'
   order by created_at limit 1;
$$;
revoke execute on these from public, anon; grant execute to authenticated;
```

Security definer avoids recursive RLS on `company_members`.

### Per-table policies (loads shown; same shape for others)

```sql
-- ILLUSTRATIVE
create policy loads_select_member on loads for select to authenticated
  using (has_company_role(company_id, array['owner','dispatcher','viewer'])
         or (has_company_role(company_id, array['driver']) and user_id = (select auth.uid())));
create policy loads_write_staff on loads for insert to authenticated
  with check (has_company_role(company_id, array['owner','dispatcher']) and user_id = (select auth.uid()));
create policy loads_update_staff on loads for update to authenticated
  using (has_company_role(company_id, array['owner','dispatcher']))
  with check (has_company_role(company_id, array['owner','dispatcher']));
```

- `with check` on update re-checks `company_id`, so an update can't move a row into a company you aren't staff in; plus a trigger rejecting any change of `company_id` (`if new.company_id is distinct from old.company_id then raise`), or revoke column UPDATE on `company_id`.
- **documents:** keep column grants from `..0200`; add `company_id` to the INSERT grant only. Insert check becomes `is_company_member(company_id)` and `split_part(file_path,'/',1) = company_id::text` and `split_part(file_path,'/',2) = auth.uid()::text`, and `load_id` null or same company (composite FK).
- **expenses / mileage_entries:** owner/dispatcher any row in company; driver own rows only; viewer read-only. `load_id`/`document_id` same-company via composite FK.
- **extraction_runs:** still server-written; select for owner/dispatcher in company, own rows for others.
- **mileage triggers** (`loads_compute_rate_per_mile`, `mileage_entries_recalc_load`) are security definer and keyed by `load_id`; unaffected.
- **create_load_from_document** (security invoker): add `company_id` from the document to the `loads` insert (and stops via trigger).

### Anti-escalation (company_members)
- No self-update of `role`/`status` (`user_id <> auth.uid()` in update policy).
- Only owners insert/update/delete members; only owners can grant `owner`.
- Constraint trigger: after update/delete, each company must still have ≥1 active owner (`raise` otherwise). Lock the company row (`select ... for update`) to avoid races.
- `company_id` and `user_id` on member rows are immutable.
- companies: update by owners only, and only branding columns (column grants); plan/limit columns are service-role only.

### Performance
- Always `(select auth.uid())` so it's evaluated once per statement (initPlan).
- Index `company_members (user_id) where status='active'` + PK `(company_id, user_id)`.
- Index every `company_id` column, leading the common sort/filter column.
- Add explicit `.eq('company_id', ...)` filters in hot reads only if `EXPLAIN` shows it helps (RLS remains the guard).

## 5. Storage

- New paths: `{company_id}/{uid}/{ts}-{name}` (keeps uploader in the path; makes "driver own files" possible).
- Policies on `storage.objects` (bucket `documents`):
  - insert: `foldername[1]` is a company the user is an active member of (non-viewer) **and** `foldername[2] = auth.uid()`.
  - select: member of `foldername[1]` (driver: only `foldername[2] = auth.uid()`, pending the visibility decision).
  - delete: owner/dispatcher in company, or the uploader.
- **Existing objects** (`{uid}/...`): keep the old `*_own` policies during a dual-read period, so old `documents.file_path` values keep working for signed URLs (`app/loads/[id]/page.js:73`, `app/expenses/page.js:479`, `app/documents/page.js:242`). Add a select policy letting company staff read legacy `{uid}/...` objects of fellow members (via a helper).
- Optional copy job (service role script): copy each object to `{company_id}/{uid}/...`, update `documents.file_path` in the same step per row, verify, then delete the old object later. Not required for launch.
- `/api/extract/route.js:83` check becomes "path starts with `${company_id}/` for a company the user belongs to, or legacy `${user.id}/`".
- `allowed_mime_types` and 10 MB limit unchanged. A separate public-read `branding` bucket for logos (png/svg-free list: png/jpeg/webp only).

## 6. Per-company AI limits

```sql
-- ILLUSTRATIVE: same signature, so /api/extract and /api/extract-receipt calls don't change
create or replace function public.claim_extraction_slot(p_user uuid, p_document uuid, p_kind text default 'rate_confirmation')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_ch int; v_cd int; ...
begin
  -- company from the document when given, else the user's single membership
  select coalesce((select company_id from documents where id = p_document), current_company_for(p_user)) into v_company;
  perform pg_advisory_xact_lock(hashtext(v_company::text || p_kind));
  -- per-company limits from companies.ai_<kind>_per_hour/day
  -- per-user cap stays (today's hard-coded numbers) so one driver can't exhaust the fleet's quota
  ...
  insert into extraction_runs (user_id, company_id, document_id, status, kind) values (...);
end $$;
```

- `current_company_for(p_user)` is a service-side variant (no `auth.uid()`; the RPC is called with service role).
- Defaults on `companies` equal today's numbers, so FS Trucks sees identical limits.
- Must verify the document's company matches a membership of `p_user` (defense in depth beyond the route).

## 7. Branding

- Read once per session: the user's company (`companies` row via membership) in a small `useCompany()` hook / context used by `app/components/AppNav.js` and `app/page.js`.
- `app/layout.js` metadata is static server-side; keep `PowerHaul TMS` as the default title. Per-company `<title>` would need a host-based lookup (custom domains = open question).
- Defaults when fields are null: `display_name` → **PowerHaul TMS**, no logo (text mark), current colors, support email blank. FS Trucks initially has all-null branding ⇒ looks exactly as today.

## 8. Zero-downtime migration path (expand → backfill → contract)

| Step | What | Marc-visible change | Rollback |
|---|---|---|---|
| M1 Expand | Create `companies`, `company_members`, helpers. No policies on existing tables change. | none | `drop table company_members, companies; drop function ...` |
| M2 Seed | Insert `FS Trucks` (slug `fs-trucks`); insert Marc as `owner` (looked up by email, not hard-coded uuid). | none | `delete from companies where slug='fs-trucks'` |
| M3 Add columns | Nullable `company_id` + indexes on loads/stops/documents/expenses/mileage_entries/extraction_runs (`create index concurrently`). | none | `alter table ... drop column company_id` |
| M4 Default trigger | `before insert` trigger: `new.company_id := coalesce(new.company_id, current_company_id())` (and stops from load; extraction_runs from document/user). App code untouched. | none | `drop trigger` |
| M5 Backfill | `update <t> set company_id = <fs> where user_id = <marc> and company_id is null` in batches; stops from loads. Any other existing users (invited testers) get their own company or join FS Trucks — Marc decides (open question). | none | `update <t> set company_id = null` |
| M6 Dual policies | Add membership policies **alongside** the `*_own` policies (Postgres ORs permissive policies). | none (Marc passes both) | drop new policies |
| M7 App writes | App sends `company_id` explicitly; new uploads go to `{company_id}/{uid}/...`; extract route accepts both path shapes. | none visible | revert PR (trigger still fills) |
| M8 Switch | Drop old `*_own` table policies (keep legacy storage read policy). | none | re-run old policy SQL from `..0100/0400/0600/0700/0710` |
| M9 Contract | Verify zero nulls, then `alter column company_id set not null`, add composite FKs (`not valid` → `validate`). | none | `drop not null`, drop constraints |
| M10 (later) | Optional storage copy job; drop legacy storage policies after all paths moved. | none | keep legacy policies |

Every migration file is idempotent (`if not exists`, `drop policy if exists`) like the existing ones, with a commented "Rollback" block at the bottom.

## 9. Rollout PRs (in order; each small and reversible)

1. **docs** — this design (no code).
2. **db: companies + members + helpers** (M1) — rollback: drop.
3. **db: seed FS Trucks + Marc owner** (M2) — rollback: delete rows.
4. **db: company_id columns + indexes + default trigger** (M3–M4) — rollback: drop trigger/columns.
5. **db: backfill** (M5) + verification queries in PR body — rollback: null out.
6. **db: membership RLS alongside old policies** (M6) + isolation tests — rollback: drop new policies.
7. **app: explicit company_id on writes + new storage paths + extract route dual path check** (M7) — rollback: revert.
8. **db: claim_extraction_slot per company** — rollback: re-run `..0730` function.
9. **app: branding hook in AppNav/home** (defaults = today) — rollback: revert.
10. **db: drop old policies** (M8) — rollback: re-create.
11. **db: NOT NULL + composite FKs** (M9) — rollback: drop constraints.
12. **app: members page + invites** (owner only) — rollback: revert/hide route.

Any core owner-operator fix preempts this queue. Each DB PR: Marc runs SQL in the Supabase SQL editor (current process), Taylor reviews first.

## 10. Test plan

**Fixtures:** Company A (FS Trucks, user `a_owner`), Company B (`b_owner`, `b_driver`, `b_viewer`, `b_dispatcher`). Run as SQL with `set local role authenticated; set local request.jwt.claims = '{"sub":"<uid>"}'` (pgTAP or plain `do` blocks), plus a browser smoke test.

**Cross-company isolation (all must fail / return 0 rows)**
- `b_owner` selects A's loads/stops/documents/expenses/mileage/extraction_runs.
- `b_owner` inserts a load/expense/mileage/document with `company_id = A`.
- `b_owner` inserts an expense in B with `load_id` / `document_id` from A.
- `b_owner` updates own row setting `company_id = A`.
- `b_owner` updates/deletes A rows by id.
- Storage: `b_owner` uploads to `A/...`, downloads/creates signed URL for an A object (new and legacy `{a_uid}/...` path), deletes it.
- `/api/extract` with a B token and an A `documentId` → 403/404.
- RPC limits: exhausting B's quota doesn't affect A; per-user cap still applies inside B; a client (`authenticated`) cannot call `claim_extraction_slot`.

**Per-role**
- viewer: reads OK, every write fails.
- driver: own expenses/mileage CRUD OK; others' rows hidden (pending visibility decision).
- dispatcher: CRUD on ops data; cannot modify members.
- owner: manage members; cannot demote/remove the last owner; non-owners cannot self-promote; nobody can change their own role.

**Migration verification (Marc's data)**
```sql
-- ILLUSTRATIVE: run before M5 and after M9; counts must match
select 'loads', count(*) from loads where user_id = :marc union all
select 'stops', count(*) from stops s join loads l on l.id = s.load_id where l.user_id = :marc union all
select 'documents', count(*) from documents where user_id = :marc union all ...;
-- no orphans / nulls
select count(*) from loads where company_id is null;   -- 0 (each table)
select count(*) from stops s join loads l on l.id = s.load_id where s.company_id <> l.company_id;  -- 0
select count(*) from expenses e join loads l on l.id = e.load_id where e.company_id <> l.company_id; -- 0
-- dashboard totals for the last 4 weeks equal before/after
```

**Regression checklist (Marc, Android + iPhone)**
- [ ] Upload rate con (PDF + photo/HEIC) → extraction → create load with stops
- [ ] Old documents still open (signed URLs on legacy paths)
- [ ] Receipt photo → auto-fill amount/date/category/vendor → save expense
- [ ] Expenses add/edit/delete, link to load, per-load totals
- [ ] Mileage add/delete; `total_miles` / `rate_per_mile` recompute
- [ ] Dashboard weekly numbers unchanged
- [ ] Loads list never shows false "No loads yet"
- [ ] Title/nav still "PowerHaul TMS"

## 11. Open questions for Marc

1. **Driver visibility:** only loads assigned to them (needs `loads.assigned_driver_id`), or everything in the company? Can drivers change load status?
2. Should drivers see rate/pay on loads, or should rate be hidden from drivers?
3. Existing non-Marc users (e.g. testers like Troy): join FS Trucks, or get their own companies?
4. **Invites:** email invite links (needs email sending) or owner creates accounts? Can a user belong to multiple companies (company switcher)?
5. **Billing:** per truck, per seat, or flat per plan? Who sets plan/limits — only you (service role)?
6. **White-label depth:** logo + color + name only, or **custom domains** (e.g. `tms.customer.com`), custom email sender, custom app icon?
7. Default AI limits for new companies — same as today, or scaled per truck?
8. Data retention/export when a company leaves.
9. Do dispatchers manage members, or owners only?
