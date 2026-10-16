-- Carrier packet step F: "Send to broker" log. ADDITIVE ONLY. Depends on 20261016001600 (filled_path).
-- One row per email actually handed to Postmark. Rows are written only by the server route (service role);
-- company members can read their company's history. No client insert/update/delete.
create table if not exists public.packet_sends (
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
  filled_path text not null,
  postmark_message_id text null
);
create index if not exists packet_sends_packet_idx on public.packet_sends (packet_id, sent_at desc);
alter table public.packet_sends enable row level security;
drop policy if exists packet_sends_select on public.packet_sends;
create policy packet_sends_select on public.packet_sends for select to authenticated
  using (public.packet_role(owner_id) is not null);

alter table public.packets add column if not exists sent_at timestamptz;
alter table public.packets add column if not exists sent_by uuid null references auth.users(id) on delete set null;
