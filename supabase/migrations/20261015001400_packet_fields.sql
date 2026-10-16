-- Carrier packet PR D: detected/named fields per packet. ADDITIVE ONLY. Depends on 20261015001300.
-- Holds positions + profile_key names only; never TIN/ACH values (those are filled server-side at render time).
create table if not exists public.packet_fields (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references public.packets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  field_key text not null,               -- detector id, e.g. p2-f7
  page int not null check (page >= 1),
  kind text not null check (kind in ('text', 'checkbox', 'signature', 'date')),
  label text,
  box jsonb not null,                    -- [x0,y0,x1,y1] raster px at dpi
  dpi int not null default 200,
  profile_key text,                      -- null = unmapped (manual mapping)
  confidence real not null default 0,
  source text not null default 'local' check (source in ('local', 'model', 'user')),
  needs_confirm boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packet_fields_unique unique (packet_id, field_key)
);
create index if not exists packet_fields_packet_idx on public.packet_fields(packet_id, page);
alter table public.packet_fields enable row level security;
drop policy if exists packet_fields_select on public.packet_fields;
create policy packet_fields_select on public.packet_fields for select to authenticated
  using (public.packet_role(owner_id) is not null);
drop policy if exists packet_fields_update on public.packet_fields;
create policy packet_fields_update on public.packet_fields for update to authenticated
  using (public.packet_role(owner_id) in ('owner', 'dispatcher', 'management'))
  with check (public.packet_role(owner_id) in ('owner', 'dispatcher', 'management'));
-- Inserts come from the server (service role) after detection.
