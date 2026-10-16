-- Carrier packet PR E: signatures + filled PDF. ADDITIVE ONLY (new nullable columns). Depends on 20261015001500.
-- Signature PNGs and filled PDFs live in the private documents bucket under the OWNER's folder
-- ({owner_id}/packets/signatures/..., {owner_id}/packets/filled/...), written by server routes with the service key.
alter table public.packet_fields add column if not exists signature_path text;
alter table public.packet_fields add column if not exists signer_name text;
alter table public.packet_fields add column if not exists signed_at timestamptz;
alter table public.packet_fields add column if not exists signed_by uuid null references auth.users(id) on delete set null;
alter table public.packets add column if not exists filled_path text;
alter table public.packets add column if not exists filled_at timestamptz;
alter table public.packets add column if not exists filled_by uuid null references auth.users(id) on delete set null;
