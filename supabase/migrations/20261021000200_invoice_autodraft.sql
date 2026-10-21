-- Invoicing PR 2: auto-draft an invoice when a load is marked delivered (Marc's pick 5). ADDITIVE ONLY, idempotent.
-- NOT APPLIED. Depends on 20261021000100_invoicing.sql.
-- Fires on ANY path that sets loads.status to 'delivered' (load page, Dispatch, server routes). Makes a draft only when the
-- load has no active (non-void) invoice. The draft starts with one Linehaul line from loads.rate; the Invoice tab fills
-- in the broker / remit-to details when it's opened. A failure here never blocks the status change.
create or replace function public.loads_autodraft_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
declare p public.company_profiles; b public.brokers; v_factored boolean; v_lines jsonb;
begin
  if new.status <> 'delivered' or old.status is not distinct from 'delivered' then return new; end if;
  if exists (select 1 from public.invoices i where i.load_id = new.id and i.status <> 'void') then return new; end if;
  begin
    select * into p from public.company_profiles where owner_id = new.user_id;
    if new.broker_id is not null then select * into b from public.brokers where id = new.broker_id and owner_id = new.user_id; end if;
    v_factored := coalesce(new.factored, p.default_factor_id is not null);
    v_lines := case when coalesce(new.rate, 0) > 0
      then jsonb_build_array(jsonb_build_object('type', 'linehaul', 'label', 'Linehaul', 'amount', round(new.rate::numeric, 2), 'note', null))
      else '[]'::jsonb end;
    insert into public.invoices (owner_id, load_id, status, broker_id, bill_to, factored, factor_id, terms_days, load_ref, line_items, total, auto_drafted, created_by)
    values (new.user_id, new.id, 'draft', b.id,
      jsonb_build_object('name', coalesce(b.name, new.broker_name), 'mc_number', b.mc_number, 'address', b.address, 'emails', to_jsonb(coalesce(b.billing_emails, '{}'::text[]))),
      v_factored, case when v_factored then p.default_factor_id end,
      coalesce(b.terms_days, p.default_terms_days, 30),
      jsonb_build_object('load_number', new.broker_load_number),
      v_lines, case when coalesce(new.rate, 0) > 0 then round(new.rate::numeric, 2) else 0 end, true, auth.uid());
    insert into public.invoice_events (invoice_id, owner_id, kind, created_by)
      select i.id, i.owner_id, 'drafted', auth.uid() from public.invoices i where i.load_id = new.id and i.status = 'draft' order by i.created_at desc limit 1;
  exception when others then
    raise warning 'invoice auto-draft skipped for load %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists loads_autodraft_invoice on public.loads;
create trigger loads_autodraft_invoice after update of status on public.loads
  for each row execute function public.loads_autodraft_invoice();
