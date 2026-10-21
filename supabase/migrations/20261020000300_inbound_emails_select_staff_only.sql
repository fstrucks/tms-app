-- PR #112: inbound_emails readable only by owner / management / dispatcher of the owning company (drivers excluded).
-- Already applied on prod (Oct 20, 2026). Idempotent: re-running drops and recreates the same policy.
-- The Postmark webhook uses the service role (unaffected).
begin;
drop policy if exists inbound_emails_select on public.inbound_emails;
create policy inbound_emails_select on public.inbound_emails for select to authenticated
  using (owner_id is not null and public.packet_role(owner_id) in ('owner', 'management', 'dispatcher'));
commit;
