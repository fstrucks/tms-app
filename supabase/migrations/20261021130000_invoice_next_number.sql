-- Invoicing: let the owner or Management set the next invoice number (Taylor QA #4).
-- The counter guard (20261021000100) keeps invoice_next_number unchanged unless app.invoice_finalize is on,
-- so a plain UPDATE can't move it. This definer function is the only other way in. It checks
-- billing_can_edit(p_owner), locks the company row, and refuses anything below the highest number used + 1.
-- Safe to run twice (create or replace + revoke/grant).
create or replace function public.set_invoice_next_number(p_owner uuid, p_next integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_min integer;
begin
  if p_owner is null or not public.billing_can_edit(p_owner) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select id into v_id from public.company_profiles where owner_id = p_owner for update;
  if v_id is null then
    raise exception 'no_company_profile' using errcode = 'P0001';
  end if;
  if p_next is null or p_next < 1 or p_next > 99999999 then
    raise exception 'next_number_invalid' using errcode = 'P0001';
  end if;
  select coalesce(max(invoice_seq), 0) + 1 into v_min
    from public.invoices where owner_id = p_owner and invoice_seq is not null;
  if p_next < v_min then
    raise exception 'next_number_too_low:%', v_min using errcode = 'P0001';
  end if;
  perform set_config('app.invoice_finalize', 'on', true);
  update public.company_profiles set invoice_next_number = p_next where id = v_id;
  perform set_config('app.invoice_finalize', 'off', true);
  return p_next;
end
$$;

revoke execute on function public.set_invoice_next_number(uuid, integer) from public, anon;
grant execute on function public.set_invoice_next_number(uuid, integer) to authenticated;
