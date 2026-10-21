-- Invoicing (PR 1 of 3): brokers, factors, invoices, invoice log, company billing settings. ADDITIVE ONLY, idempotent.
-- NOT APPLIED. Depends on 20261015001200 (company_profiles / company_members) and 20261010000400 (loads).
-- Who can do what (company = the owner's user id, same as loads.user_id / packets.owner_id):
--   read:  owner, management, dispatcher ("office" roles). Drivers see nothing here.
--   write: owner and management only.
-- Invoice numbers are handed out only by public.finalize_invoice() (prefix + next number, from 1001), so they are
-- unique, in order, and never re-used. A guard trigger stops anything else from setting or changing a number.

-- 1. Role helpers (security definer so policies don't recurse through company_members RLS).
create or replace function public.billing_role(p_owner uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null or p_owner is null then null
    when p_owner = auth.uid() then 'owner'
    else (select m.role from public.company_members m join public.company_profiles p on p.id = m.profile_id
           where p.owner_id = p_owner and m.user_id = auth.uid() limit 1)
  end;
$$;
create or replace function public.billing_can_view(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.billing_role(p_owner) in ('owner', 'management', 'dispatcher'), false);
$$;
create or replace function public.billing_can_edit(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.billing_role(p_owner) in ('owner', 'management'), false);
$$;
revoke execute on function public.billing_role(uuid), public.billing_can_view(uuid), public.billing_can_edit(uuid) from public, anon;
grant execute on function public.billing_role(uuid), public.billing_can_view(uuid), public.billing_can_edit(uuid) to authenticated;

-- 2. Factoring companies (per company). Nothing is seeded.
create table if not exists public.factors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  submission_email text null,
  portal_url text null,
  remit_to text null,                 -- printed as "Remit to" on factored invoices
  cutoff_time text null,              -- e.g. "11:00 AM CT" (info only)
  packet_format text not null default 'merged' check (packet_format in ('merged', 'separate')),
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists factors_owner_name_uniq on public.factors (owner_id, lower(btrim(name)));

-- 3. Brokers (per company). terms_days null = company default (Net 30).
create table if not exists public.brokers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  mc_number text null,
  address text null,
  billing_emails text[] not null default '{}',
  terms_days integer null check (terms_days is null or terms_days between 0 and 120),
  quick_pay_terms text null,
  noa_on_file boolean not null default false,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists brokers_owner_name_uniq on public.brokers (owner_id, lower(btrim(name)));

-- 4. Company billing settings.
alter table public.company_profiles add column if not exists invoice_prefix text not null default 'INV-';
alter table public.company_profiles add column if not exists invoice_next_number integer not null default 1001;
alter table public.company_profiles add column if not exists default_terms_days integer not null default 30;
alter table public.company_profiles add column if not exists default_factor_id uuid null references public.factors(id) on delete set null;
alter table public.company_profiles add column if not exists remit_to text null;       -- own remit-to when not factored
alter table public.company_profiles add column if not exists logo_path text null;      -- private Storage path, documents bucket
alter table public.company_profiles drop constraint if exists company_profiles_terms_check;
alter table public.company_profiles add constraint company_profiles_terms_check check (default_terms_days between 0 and 120);

-- 5. Per-load billing: which broker record, and the factoring switch (null = follow the company default factor).
--    No client grant: the app writes these through the server after checking the caller is owner / management.
alter table public.loads add column if not exists broker_id uuid null references public.brokers(id) on delete set null;
alter table public.loads add column if not exists factored boolean null;

-- 6. Invoices: one per load (one non-void invoice per load). Bill-to, remit-to and line items are copied in when the
--    draft is made / saved, so a finalized invoice never changes when the broker or company record changes later.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  load_id uuid null references public.loads(id) on delete set null,   -- deleting a load keeps its invoice
  status text not null default 'draft' check (status in ('draft', 'ready', 'sent', 'paid', 'short_paid', 'void')),
  invoice_number text null,
  invoice_seq integer null,
  invoice_date date null,
  terms_days integer not null default 30 check (terms_days between 0 and 120),
  due_date date null,
  broker_id uuid null references public.brokers(id) on delete set null,
  bill_to jsonb not null default '{}'::jsonb,         -- { name, mc_number, address, emails[] }
  factored boolean not null default false,
  factor_id uuid null references public.factors(id) on delete set null,
  remit_to text null,
  load_ref jsonb not null default '{}'::jsonb,        -- { load_number, pickup_numbers[], lane[], truck, commodity, weight }
  line_items jsonb not null default '[]'::jsonb,      -- [{ type, label, amount, note }]
  total numeric(12, 2) not null default 0 check (total >= 0),
  notes text null,
  finalized_at timestamptz null,
  finalized_by uuid null references auth.users(id) on delete set null,
  sent_at timestamptz null,
  sent_to text null,
  paid_at date null,
  paid_amount numeric(12, 2) null check (paid_amount is null or paid_amount >= 0),
  void_reason text null,
  auto_drafted boolean not null default false,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_number_when_final check ((status = 'draft') = (invoice_number is null) or status = 'void')
);
create unique index if not exists invoices_owner_number_uniq on public.invoices (owner_id, invoice_number) where invoice_number is not null;
create unique index if not exists invoices_one_active_per_load on public.invoices (load_id) where load_id is not null and status <> 'void';
create index if not exists invoices_owner_idx on public.invoices (owner_id, created_at desc);

-- 7. Invoice log: downloads, prints, "Mark as sent", paid, void. Insert-only for users.
create table if not exists public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('drafted', 'finalized', 'download', 'print', 'marked_sent', 'paid', 'short_paid', 'void')),
  sent_to text null,
  files text[] not null default '{}',
  note text null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at desc);

-- 8. Guards: numbers come only from finalize_invoice(); a number never changes; owner_id never moves.
create or replace function public.invoices_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fin boolean := coalesce(current_setting('app.invoice_finalize', true), '') = 'on';
begin
  if new.load_id is not null and not exists (select 1 from public.loads l where l.id = new.load_id and l.user_id = new.owner_id) then
    raise exception 'load_not_in_company' using errcode = 'P0001';
  end if;
  if new.broker_id is not null and not exists (select 1 from public.brokers b where b.id = new.broker_id and b.owner_id = new.owner_id) then
    raise exception 'broker_not_in_company' using errcode = 'P0001';
  end if;
  if new.factor_id is not null and not exists (select 1 from public.factors f where f.id = new.factor_id and f.owner_id = new.owner_id) then
    raise exception 'factor_not_in_company' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if (new.invoice_number is not null or new.invoice_seq is not null) and not v_fin then raise exception 'invoice_number_reserved' using errcode = 'P0001'; end if;
  else
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
    if old.invoice_number is not null and (new.invoice_number is distinct from old.invoice_number or new.invoice_seq is distinct from old.invoice_seq) then
      raise exception 'invoice_number_locked' using errcode = 'P0001';
    end if;
    if old.invoice_number is null and (new.invoice_number is not null or new.invoice_seq is not null) and not v_fin then
      raise exception 'invoice_number_reserved' using errcode = 'P0001';
    end if;
    -- Line items, bill-to and amounts are locked once finalized (void it and start a new draft to change them).
    if old.status <> 'draft' and (new.line_items is distinct from old.line_items or new.total is distinct from old.total
        or new.bill_to is distinct from old.bill_to or new.remit_to is distinct from old.remit_to or new.load_id is distinct from old.load_id) then
      raise exception 'invoice_locked' using errcode = 'P0001';
    end if;
    if old.status = 'void' and new.status <> 'void' then raise exception 'invoice_void' using errcode = 'P0001'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists invoices_guard on public.invoices;
create trigger invoices_guard before insert or update on public.invoices for each row execute function public.invoices_guard();

create or replace function public.company_profiles_invoice_counter_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.invoice_next_number is distinct from old.invoice_next_number and coalesce(current_setting('app.invoice_finalize', true), '') <> 'on' then
    new.invoice_next_number := old.invoice_next_number; -- only finalize_invoice() moves the counter
  end if;
  -- Billing settings: owner / management only (dispatchers can still edit the rest of the profile).
  -- auth.uid() is null for the server's service role, which checks the role itself.
  if auth.uid() is not null and not public.billing_can_edit(new.owner_id) and (
       new.invoice_prefix is distinct from old.invoice_prefix or new.default_terms_days is distinct from old.default_terms_days
    or new.default_factor_id is distinct from old.default_factor_id or new.remit_to is distinct from old.remit_to
    or new.logo_path is distinct from old.logo_path) then
    raise exception 'billing_not_allowed' using errcode = 'P0001';
  end if;
  if new.default_factor_id is not null and not exists (select 1 from public.factors f where f.id = new.default_factor_id and f.owner_id = new.owner_id) then
    raise exception 'factor_not_in_company' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists company_profiles_invoice_counter_guard on public.company_profiles;
create trigger company_profiles_invoice_counter_guard before update on public.company_profiles
  for each row execute function public.company_profiles_invoice_counter_guard();

create or replace function public.billing_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); new.owner_id := old.owner_id; return new; end $$;
drop trigger if exists brokers_touch on public.brokers;
create trigger brokers_touch before update on public.brokers for each row execute function public.billing_touch();
drop trigger if exists factors_touch on public.factors;
create trigger factors_touch before update on public.factors for each row execute function public.billing_touch();

-- 9. finalize_invoice(invoice): owner / management only. Locks the company row, gives the next number
--    (prefix || n, from 1001), sets the invoice date and due date, status 'ready', moves the load to 'invoiced'.
--    Errors: not_allowed, not_found, not_draft, no_lines, no_company_profile.
create or replace function public.finalize_invoice(p_invoice uuid, p_date date default null)
returns public.invoices language plpgsql security definer set search_path = public as $$
declare v public.invoices; p public.company_profiles; v_n integer; v_date date;
begin
  select * into v from public.invoices where id = p_invoice for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not public.billing_can_edit(v.owner_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if v.status <> 'draft' then raise exception 'not_draft' using errcode = 'P0001'; end if;
  if jsonb_array_length(coalesce(v.line_items, '[]'::jsonb)) = 0 or v.total <= 0 then raise exception 'no_lines' using errcode = 'P0001'; end if;
  select * into p from public.company_profiles where owner_id = v.owner_id for update;
  if not found then raise exception 'no_company_profile' using errcode = 'P0001'; end if;
  v_n := greatest(coalesce(p.invoice_next_number, 1001), 1);
  -- Skip any number already used (e.g. the prefix was changed back): numbers are never re-used.
  while exists (select 1 from public.invoices i where i.owner_id = v.owner_id and i.invoice_number = coalesce(p.invoice_prefix, 'INV-') || v_n) loop
    v_n := v_n + 1;
  end loop;
  v_date := coalesce(p_date, (now() at time zone 'America/Chicago')::date);
  perform set_config('app.invoice_finalize', 'on', true);
  update public.company_profiles set invoice_next_number = v_n + 1 where id = p.id;
  update public.invoices set status = 'ready', invoice_seq = v_n, invoice_number = coalesce(p.invoice_prefix, 'INV-') || v_n,
         invoice_date = v_date, due_date = v_date + v.terms_days, finalized_at = now(), finalized_by = auth.uid()
   where id = v.id returning * into v;
  perform set_config('app.invoice_finalize', 'off', true);
  if v.load_id is not null then
    update public.loads set status = 'invoiced' where id = v.load_id and user_id = v.owner_id and status = 'delivered';
  end if;
  insert into public.invoice_events (invoice_id, owner_id, kind, created_by) values (v.id, v.owner_id, 'finalized', auth.uid());
  return v;
end $$;
revoke execute on function public.finalize_invoice(uuid, date) from public, anon;
grant execute on function public.finalize_invoice(uuid, date) to authenticated;

-- 10. RLS.
alter table public.brokers enable row level security;
alter table public.factors enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_events enable row level security;

drop policy if exists brokers_select on public.brokers;
create policy brokers_select on public.brokers for select to authenticated using (public.billing_can_view(owner_id));
drop policy if exists brokers_write on public.brokers;
create policy brokers_write on public.brokers for all to authenticated
  using (public.billing_can_edit(owner_id)) with check (public.billing_can_edit(owner_id));

drop policy if exists factors_select on public.factors;
create policy factors_select on public.factors for select to authenticated using (public.billing_can_view(owner_id));
drop policy if exists factors_write on public.factors;
create policy factors_write on public.factors for all to authenticated
  using (public.billing_can_edit(owner_id)) with check (public.billing_can_edit(owner_id));

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated using (public.billing_can_view(owner_id));
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices for insert to authenticated with check (public.billing_can_edit(owner_id));
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices for update to authenticated
  using (public.billing_can_edit(owner_id)) with check (public.billing_can_edit(owner_id));
drop policy if exists invoices_delete on public.invoices;  -- only unnumbered drafts can be deleted
create policy invoices_delete on public.invoices for delete to authenticated
  using (public.billing_can_edit(owner_id) and status = 'draft' and invoice_number is null);

drop policy if exists invoice_events_select on public.invoice_events;
create policy invoice_events_select on public.invoice_events for select to authenticated using (public.billing_can_view(owner_id));
drop policy if exists invoice_events_insert on public.invoice_events;
create policy invoice_events_insert on public.invoice_events for insert to authenticated
  with check (public.billing_can_edit(owner_id) and created_by = auth.uid()
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.owner_id = invoice_events.owner_id));

revoke all on public.brokers, public.factors, public.invoices, public.invoice_events from anon;
grant select, insert, update, delete on public.brokers, public.factors, public.invoices to authenticated;
grant select, insert on public.invoice_events to authenticated;

notify pgrst, 'reload schema';
