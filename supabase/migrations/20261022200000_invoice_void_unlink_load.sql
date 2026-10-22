-- Deleting a load whose only invoices are void failed with invoice_locked: loads -> invoices.load_id is
-- ON DELETE SET NULL, and invoices_guard blocked any load_id change on a finalized invoice. Same function as
-- 20261021000100_invoicing.sql section 8, with one change: a void invoice may have load_id set to null.
-- Non-void finalized invoices stay locked to their load. Idempotent; no data changes; trigger unchanged.
create or replace function public.invoices_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fin boolean := coalesce(current_setting('app.invoice_finalize', true), '') = 'on';
begin
  if new.load_id is not null and not exists (select 1 from public.loads l where l.id = new.load_id and l.user_id = new.owner_id) then
    raise exception 'load_not_in_company' using errcode = 'P0001';
  end if;
  if new.broker_id is not null and not exists (select 1 from public.brokers b where b.id = new.broker_id and b.owner_id = new.owner_id) then
    raise exception 'broker_not_in_company' using errcode = 'P0001';
  end if;
  if new.factor_id is not null and not exists (select 1 from public.factors f where f.id = new.factor_id and f.owner_id = new.owner_id) then
    raise exception 'factor_not_in_company' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if (new.invoice_number is not null or new.invoice_seq is not null) and not v_fin then raise exception 'invoice_number_reserved' using errcode = 'P0001'; end if;
  else
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
    if old.invoice_number is not null and (new.invoice_number is distinct from old.invoice_number or new.invoice_seq is distinct from old.invoice_seq) then
      raise exception 'invoice_number_locked' using errcode = 'P0001';
    end if;
    if old.invoice_number is null and (new.invoice_number is not null or new.invoice_seq is not null) and not v_fin then
      raise exception 'invoice_number_reserved' using errcode = 'P0001';
    end if;
    -- Line items, bill-to and amounts are locked once finalized (void it and start a new draft to change them).
    -- Exception: a VOID invoice may be unlinked from its load (load_id -> null), so a load whose invoices are all void can be deleted.
    if old.status <> 'draft' and (new.line_items is distinct from old.line_items or new.total is distinct from old.total
        or new.bill_to is distinct from old.bill_to or new.remit_to is distinct from old.remit_to
        or (new.load_id is distinct from old.load_id and not (old.status = 'void' and new.load_id is null))) then
      raise exception 'invoice_locked' using errcode = 'P0001';
    end if;
    if old.status = 'void' and new.status <> 'void' then raise exception 'invoice_void' using errcode = 'P0001'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
