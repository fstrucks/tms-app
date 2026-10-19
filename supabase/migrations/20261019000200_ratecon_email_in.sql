-- Rate con email-in. ADDITIVE ONLY (new table + new nullable/defaulted columns + new functions). NOT APPLIED.
-- Depends on 20261015001300_packets_inbound.sql (inbound_emails) and the documents table.
--
-- Each user gets a secret address ratecon+<token>@in.fstrucks.com. The Postmark webhook
-- (app/api/inbound/postmark) looks the token up with the service role, stores each PDF as a rate_confirmation
-- document in that user's folder (source = 'email') and runs the existing rate con reader. The document is a
-- DRAFT for review on Documents: a load is only created when the user taps "Create load"
-- (create_load_from_document, unchanged). Nothing here creates loads.

-- 1. Per-user secret address. Token = 32 hex chars (122 random bits). Users read their own row; all writes
--    go through the functions below (no direct insert/update/delete grants).
create table if not exists public.ratecon_inbound_addresses (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique check (token ~ '^[a-f0-9]{32}$'),
  allowed_senders text[] not null default '{}'::text[] check (cardinality(allowed_senders) <= 20),
  created_at timestamptz not null default now(),
  rotated_at timestamptz null
);
alter table public.ratecon_inbound_addresses enable row level security;
revoke all on public.ratecon_inbound_addresses from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.ratecon_inbound_addresses from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.ratecon_inbound_addresses from authenticated';
    execute 'grant select on public.ratecon_inbound_addresses to authenticated';
  end if;
end $$;
drop policy if exists ratecon_inbound_addresses_select on public.ratecon_inbound_addresses;
create policy ratecon_inbound_addresses_select on public.ratecon_inbound_addresses for select to authenticated
  using (user_id = auth.uid());

-- 2. Mark email rows. documents: where it came from, the email, and how the AI read went.
--    extraction_status: null = uploaded the old way; pending = reader running; done = read OK;
--    failed = reader failed (the PDF is kept; the user enters the load by hand or taps Run extraction).
alter table public.documents add column if not exists source text not null default 'upload';
alter table public.documents add column if not exists inbound_email_id uuid null references public.inbound_emails(id) on delete set null;
alter table public.documents add column if not exists extraction_status text null;
alter table public.documents add column if not exists extraction_error text null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.documents'::regclass and conname = 'documents_source_check') then
    alter table public.documents add constraint documents_source_check check (source in ('upload', 'email'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.documents'::regclass and conname = 'documents_extraction_status_check') then
    alter table public.documents add constraint documents_extraction_status_check check (extraction_status is null or extraction_status in ('pending', 'done', 'failed'));
  end if;
end $$;
create index if not exists documents_email_drafts_idx on public.documents(user_id, created_at desc) where source = 'email' and load_id is null;
-- Client insert/update stay column-limited (20261010000200): users can't set source / extraction_* themselves.

-- inbound_emails: which address it came in on. Dedupe stays the existing unique (provider, message_id);
-- rate con mail uses message_id = 'ratecon:' || Postmark MessageID, so a Postmark retry is a no-op.
alter table public.inbound_emails add column if not exists kind text not null default 'packet';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inbound_emails'::regclass and conname = 'inbound_emails_kind_check') then
    alter table public.inbound_emails add constraint inbound_emails_kind_check check (kind in ('packet', 'ratecon'));
  end if;
end $$;

-- 3. Functions for the signed-in user (authenticated only).
create or replace function public.ratecon_address_get()
returns table (token text, allowed_senders text[], rotated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  insert into public.ratecon_inbound_addresses (user_id, token) values (auth.uid(), replace(gen_random_uuid()::text, '-', ''))
    on conflict (user_id) do nothing;
  return query select a.token, a.allowed_senders, a.rotated_at from public.ratecon_inbound_addresses a where a.user_id = auth.uid();
end $$;

-- New token; the old address stops working at once (mail to it is dropped quietly).
create or replace function public.ratecon_address_regenerate()
returns text
language plpgsql security definer set search_path = public as $$
declare v text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  insert into public.ratecon_inbound_addresses (user_id, token) values (auth.uid(), v)
    on conflict (user_id) do update set token = excluded.token, rotated_at = now();
  return v;
end $$;

-- Optional sender allowlist: emails (broker@example.com) or domains (@example.com). Empty = anyone with the address.
create or replace function public.ratecon_set_allowed_senders(p_senders text[])
returns text[]
language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct s order by s), '{}') into v
    from (select lower(trim(x)) s from unnest(coalesce(p_senders, '{}')) x) t where s <> '';
  if cardinality(v) > 20 then raise exception 'too_many' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v) s where s !~ '^([a-z0-9._%+-]+)?@[a-z0-9.-]+\.[a-z]{2,}$') then
    raise exception 'bad_sender' using errcode = '22023';
  end if;
  insert into public.ratecon_inbound_addresses (user_id, token, allowed_senders) values (auth.uid(), replace(gen_random_uuid()::text, '-', ''), v)
    on conflict (user_id) do update set allowed_senders = excluded.allowed_senders;
  return v;
end $$;

-- 4. Token → user, for the webhook. Service role only.
create or replace function public.ratecon_owner_for_token(p_token text)
returns table (user_id uuid, allowed_senders text[])
language sql stable security definer set search_path = public as $$
  select a.user_id, a.allowed_senders from public.ratecon_inbound_addresses a where a.token = lower(trim(p_token));
$$;

revoke all on function public.ratecon_address_get() from public;
revoke all on function public.ratecon_address_regenerate() from public;
revoke all on function public.ratecon_set_allowed_senders(text[]) from public;
revoke all on function public.ratecon_owner_for_token(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.ratecon_address_get() from anon';
    execute 'revoke all on function public.ratecon_address_regenerate() from anon';
    execute 'revoke all on function public.ratecon_set_allowed_senders(text[]) from anon';
    execute 'revoke all on function public.ratecon_owner_for_token(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.ratecon_address_get() to authenticated';
    execute 'grant execute on function public.ratecon_address_regenerate() to authenticated';
    execute 'grant execute on function public.ratecon_set_allowed_senders(text[]) to authenticated';
    execute 'revoke all on function public.ratecon_owner_for_token(text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.ratecon_owner_for_token(text) to service_role';
    execute 'grant select, insert, update on public.ratecon_inbound_addresses to service_role';
  end if;
end $$;
