-- Carrier packet PR C: inbound emails + packets. ADDITIVE ONLY. Depends on 20261015001200_company_profiles.sql.
-- Ownership: owner_id now (same pattern as company_profiles); company_id reserved for #27.
-- The Postmark webhook writes with the service role (no user session); users read via RLS.

create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid null references auth.users(id) on delete set null, -- null = unmatched sender
  company_id uuid null,
  provider text not null default 'postmark',
  message_id text not null,
  from_email text not null,
  to_emails text,
  cc_emails text,
  subject text,
  in_reply_to text,
  references_header text,
  headers jsonb not null default '[]'::jsonb,
  status text not null default 'received' check (status in ('received', 'matched', 'unmatched', 'rejected')),
  attachment_count int not null default 0,
  rejected_attachments jsonb not null default '[]'::jsonb,
  received_at timestamptz not null default now(),
  constraint inbound_emails_message_unique unique (provider, message_id)
);
create index if not exists inbound_emails_owner_idx on public.inbound_emails(owner_id, received_at desc);

create table if not exists public.packets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid null,
  source text not null check (source in ('upload', 'email')),
  status text not null default 'received' check (status in ('received', 'processing', 'review', 'signed', 'sent', 'archived', 'error')),
  inbound_email_id uuid null references public.inbound_emails(id) on delete set null,
  uploaded_by uuid null references auth.users(id) on delete set null,
  broker_name text,
  subject text,
  file_path text not null,
  original_filename text,
  size_bytes int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists packets_owner_idx on public.packets(owner_id, created_at desc);

-- Role on the company that owns p_owner's data (owner_id-keyed today; swap for company_id in #27).
create or replace function public.packet_role(p_owner uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when p_owner = auth.uid() then 'owner'
    else (select m.role from public.company_members m join public.company_profiles p on p.id = m.profile_id
          where p.owner_id = p_owner and m.user_id = auth.uid() limit 1) end;
$$;

-- Sender → owner for the webhook. Account email first, then a company member's email → that company's owner.
-- Service role only.
create or replace function public.packet_owner_for_email(p_email text)
returns uuid language sql stable security definer set search_path = public, auth as $$
  select coalesce(
    (select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) and exists (select 1 from public.company_profiles p where p.owner_id = u.id) limit 1),
    (select p.owner_id from auth.users u join public.company_members m on m.user_id = u.id join public.company_profiles p on p.id = m.profile_id
       where lower(u.email) = lower(trim(p_email)) order by (m.role = 'owner') desc limit 1),
    (select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1)
  );
$$;
revoke all on function public.packet_owner_for_email(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.packet_owner_for_email(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.packet_owner_for_email(text) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.packet_owner_for_email(text) to service_role'; end if;
end $$;

alter table public.inbound_emails enable row level security;
alter table public.packets enable row level security;

drop policy if exists inbound_emails_select on public.inbound_emails;
create policy inbound_emails_select on public.inbound_emails for select to authenticated
  using (owner_id is not null and public.packet_role(owner_id) is not null);
-- No client insert/update/delete on inbound_emails (webhook uses the service role).

drop policy if exists packets_select on public.packets;
create policy packets_select on public.packets for select to authenticated
  using (public.packet_role(owner_id) is not null);
-- Any member (drivers included) can upload a packet for their company.
drop policy if exists packets_insert on public.packets;
create policy packets_insert on public.packets for insert to authenticated
  with check (source = 'upload' and uploaded_by = auth.uid() and public.packet_role(owner_id) is not null);
-- Status changes etc.: owner/dispatcher/management only.
drop policy if exists packets_update on public.packets;
create policy packets_update on public.packets for update to authenticated
  using (public.packet_role(owner_id) in ('owner', 'dispatcher', 'management'))
  with check (public.packet_role(owner_id) in ('owner', 'dispatcher', 'management'));
