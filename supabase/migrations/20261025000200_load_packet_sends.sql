-- Load export packet: email send log. ADDITIVE ONLY. Depends on 20261015001300 (packet_role), 20261021000100 (invoices).
-- One row per load packet email handed to Postmark. Also the duplicate-send key (id) and part of the monthly email cap
-- (app/lib/sendCap.js CAP_TABLES counts rows by sent_at). Rows are written only by the server (service role).
-- Office roles (owner, management, dispatcher) of the load's company can read; drivers and other companies cannot.
-- Stored: recipient emails, a short note, sizes and ids. No document bytes and no other personal data.
-- ASCII only. Idempotent: create ... if not exists / drop policy if exists / guarded grants.
--
-- load_id uses ON DELETE SET NULL, not CASCADE: the cap counts rows by sent_at, so deleting a load must not delete
-- its send rows (that would hand back cap headroom and erase the record of what was emailed). The row keeps owner_id,
-- recipients and time; only the link to the gone load is cleared. invoice_id is SET NULL for the same reason.
-- owner_id cascades with the account, matching packet_sends (the whole company's data goes with it).
create table if not exists public.load_packet_sends (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  load_id uuid null references public.loads(id) on delete set null,
  sent_by uuid null references auth.users(id) on delete set null,
  sent_at timestamptz not null default now(),
  to_emails text[] not null,
  with_invoice boolean not null,
  invoice_id uuid null references public.invoices(id) on delete set null,
  note text null check (note is null or char_length(note) <= 1000),
  size_bytes integer null check (size_bytes is null or size_bytes >= 0),
  postmark_message_id text null
);
create index if not exists load_packet_sends_owner_sent_idx on public.load_packet_sends (owner_id, sent_at);
create index if not exists load_packet_sends_load_idx on public.load_packet_sends (load_id, sent_at desc);

alter table public.load_packet_sends enable row level security;
drop policy if exists load_packet_sends_select on public.load_packet_sends;
create policy load_packet_sends_select on public.load_packet_sends for select to authenticated
  using (coalesce(public.packet_role(owner_id) in ('owner', 'management', 'dispatcher'), false));

revoke all on public.load_packet_sends from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.load_packet_sends from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete, truncate, references, trigger on public.load_packet_sends from authenticated';
    execute 'grant select on public.load_packet_sends to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant all on public.load_packet_sends to service_role'; end if;
end $$;
