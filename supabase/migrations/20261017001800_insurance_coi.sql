-- COI request + insurance info. ADDITIVE ONLY (new tables, new nullable/defaulted columns, policies, indexes).
-- Depends on 20261015001200 (company_profiles), 20261015001300 (packets, packet_role), 20261010000050 (documents).
-- NOT applied anywhere yet: needs Marc's OK (via Sam) before Dakota runs it on prod.
-- Access: reads = any company member (packet_role(owner_id) is not null, same as packets);
-- writes to agents/policies = owner or management; coi_requests are written only by the server route (service role).

-- Coverage minimums used for gap warnings (defaults pending Marc's confirmation).
alter table public.company_profiles add column if not exists min_auto_liability numeric not null default 1000000;
alter table public.company_profiles add column if not exists min_cargo numeric not null default 100000;

-- One insurance agent per company (unique per owner).
create table if not exists public.insurance_agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text,
  agency text,
  email text,
  phone text,
  updated_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insurance_agents_owner_unique unique (owner_id)
);

-- Coverage lines from uploaded COI / declarations docs. AI suggestions land with confirmed = false;
-- only confirmed rows count for gap checks.
create table if not exists public.insurance_policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid null references public.documents(id) on delete set null,
  coverage text not null check (coverage in ('auto_liability', 'cargo', 'general_liability', 'physical_damage', 'other')),
  insurer text,
  policy_number text,
  limit_amount numeric null check (limit_amount is null or limit_amount >= 0),
  effective_date date,
  expiry_date date,
  source text not null default 'manual' check (source in ('manual', 'ai')),
  confirmed boolean not null default false,
  confirmed_by uuid null references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists insurance_policies_owner_idx on public.insurance_policies (owner_id, coverage);

-- One row per COI request email handed to Postmark (claimed before sending, like packet_sends).
create table if not exists public.coi_requests (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references public.packets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  sent_by uuid null references auth.users(id) on delete set null,
  sent_at timestamptz not null default now(),
  to_emails text[] not null,
  cc_emails text[] not null default '{}',
  from_email text not null,
  reply_to text null,
  subject text not null,
  cert_holder_name text,
  cert_holder_address text,
  load_date date,
  postmark_message_id text null
);
create index if not exists coi_requests_packet_idx on public.coi_requests (packet_id, sent_at desc);
-- Monthly send cap counts packet_sends + coi_requests by sent_at.
create index if not exists coi_requests_sent_at_idx on public.coi_requests (sent_at);
create index if not exists packet_sends_sent_at_idx on public.packet_sends (sent_at);

alter table public.insurance_agents enable row level security;
alter table public.insurance_policies enable row level security;
alter table public.coi_requests enable row level security;

drop policy if exists insurance_agents_select on public.insurance_agents;
create policy insurance_agents_select on public.insurance_agents for select to authenticated
  using (public.packet_role(owner_id) is not null);
drop policy if exists insurance_agents_write on public.insurance_agents;
create policy insurance_agents_write on public.insurance_agents for all to authenticated
  using (public.packet_role(owner_id) in ('owner', 'management'))
  with check (public.packet_role(owner_id) in ('owner', 'management'));

drop policy if exists insurance_policies_select on public.insurance_policies;
create policy insurance_policies_select on public.insurance_policies for select to authenticated
  using (public.packet_role(owner_id) is not null);
drop policy if exists insurance_policies_write on public.insurance_policies;
create policy insurance_policies_write on public.insurance_policies for all to authenticated
  using (public.packet_role(owner_id) in ('owner', 'management'))
  with check (public.packet_role(owner_id) in ('owner', 'management'));

-- Read-only for members; no client insert/update/delete policy (server route uses the service role).
drop policy if exists coi_requests_select on public.coi_requests;
create policy coi_requests_select on public.coi_requests for select to authenticated
  using (public.packet_role(owner_id) is not null);
