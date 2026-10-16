-- Carrier packet PR D2: processing state + mapped values. ADDITIVE ONLY. Depends on 20261015001400_packet_fields.sql.
alter table public.packets add column if not exists processed_at timestamptz;
alter table public.packets add column if not exists processing_started_at timestamptz;
alter table public.packets add column if not exists page_count int;
alter table public.packets add column if not exists has_text_layer boolean;
alter table public.packets add column if not exists manual_reason text
  check (manual_reason is null or manual_reason in ('no_text_layer', 'too_many_pages', 'timeout', 'reader_error', 'no_fields', 'read_failed'));
alter table public.packets add column if not exists process_error text;

-- Values the user enters or confirms. Bank/EIN values are AES-256-GCM ciphertext (server-side key); never plaintext.
alter table public.packet_fields add column if not exists value_text text;
alter table public.packet_fields add column if not exists value_ciphertext text;
alter table public.packet_fields add column if not exists value_last4 text check (value_last4 is null or value_last4 ~ '^[0-9]{1,4}$');
alter table public.packet_fields add column if not exists confirmed_by uuid null references auth.users(id) on delete set null;
alter table public.packet_fields add column if not exists updated_by uuid null references auth.users(id) on delete set null;
alter table public.packet_fields add column if not exists page_w real; -- raster px of the page at dpi (for the mapping screen)
alter table public.packet_fields add column if not exists page_h real;

-- packet_fields is server-only from here: values must be encrypted server-side and ciphertext never reaches a client.
-- (A column-level revoke would not override Supabase's table-level grant, so drop the client policies instead.)
-- The app reads/writes through /api/packets/[id]/fields with a role check (members read; owner/dispatcher/management edit).
drop policy if exists packet_fields_update on public.packet_fields;
drop policy if exists packet_fields_select on public.packet_fields;
