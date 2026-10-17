-- Carrier packet G: remember each broker's packet layout. ADDITIVE ONLY (new table, new nullable columns,
-- one widened check constraint). Depends on 20261015001500 (packet processing) and 20261016001700 (packet sends).
-- NOT APPLIED. Needs Sam's/Marc's OK before it is pasted into Supabase.
--
-- A layout is a reusable set of field POSITIONS + profile-field NAMES for one broker form. It never holds values,
-- TIN/ACH data, signatures or signature paths: values are filled from the company profile at render time.
-- Rows are immutable versions: an edit inserts version n+1 and marks the old row 'superseded'.
-- Ownership follows packets: owner_id now, company_id reserved for #27 (swap packet_role then).

create table if not exists public.packet_layouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid null,
  layout_key text not null,              -- sha256 of the ordered per-page text hashes; groups the versions of one form
  version int not null default 1 check (version >= 1),
  status text not null default 'active' check (status in ('active', 'superseded', 'retired')),
  broker_name text,                      -- shown in the banner ("Layout from <broker_name>")
  broker_mc text check (broker_mc is null or broker_mc ~ '^[0-9]{4,8}$'),
  broker_domain text check (broker_domain is null or broker_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  page_count int not null check (page_count between 1 and 200),
  fingerprint jsonb not null,            -- {v:1, pages:[{w,h,text_hash,simhash,has_text}]}
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 400),
                                         -- [{page,kind,label,box,dpi,page_w,page_h,profile_key}]  (no values)
  source_packet_id uuid null references public.packets(id) on delete set null,
  created_by uuid null references auth.users(id) on delete set null,
  use_count int not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packet_layouts_version_unique unique (owner_id, layout_key, version)
);
-- One active version per form per company.
create unique index if not exists packet_layouts_active_unique on public.packet_layouts (owner_id, layout_key) where status = 'active';
-- Candidate lookups at match time.
create index if not exists packet_layouts_owner_pages_idx on public.packet_layouts (owner_id, page_count) where status = 'active';
create index if not exists packet_layouts_owner_mc_idx on public.packet_layouts (owner_id, broker_mc) where status = 'active' and broker_mc is not null;
create index if not exists packet_layouts_owner_domain_idx on public.packet_layouts (owner_id, broker_domain) where status = 'active' and broker_domain is not null;

-- RLS: any company member can read their company's layouts (positions + names only).
-- No insert/update/delete policies: writes go through server routes (service role) that check the
-- owner/dispatcher/management role, same as packet_sends.
alter table public.packet_layouts enable row level security;
drop policy if exists packet_layouts_select on public.packet_layouts;
create policy packet_layouts_select on public.packet_layouts for select to authenticated
  using (public.packet_role(owner_id) is not null);

-- Per-packet: what was found and what was applied.
alter table public.packets add column if not exists fingerprint jsonb;                 -- same shape as packet_layouts.fingerprint
alter table public.packets add column if not exists broker_mc text;                   -- MC found in the packet text (not ours)
alter table public.packets add column if not exists broker_email text;                -- original sender (forwarded From:), lowercased
alter table public.packets add column if not exists layout_id uuid null references public.packet_layouts(id) on delete set null;
alter table public.packets add column if not exists layout_score real;
alter table public.packets add column if not exists layout_applied_at timestamptz;
alter table public.packets add column if not exists layout_dismissed_at timestamptz;
create index if not exists packets_layout_idx on public.packets (layout_id) where layout_id is not null;

-- packet_fields.source gets 'layout' (rows placed from a remembered layout). Widening only: every existing row stays valid.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.packet_fields'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%source%'
  loop execute format('alter table public.packet_fields drop constraint %I', c); end loop;
end $$;
alter table public.packet_fields add constraint packet_fields_source_check
  check (source in ('local', 'model', 'user', 'layout'));
