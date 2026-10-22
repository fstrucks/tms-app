-- Short-paid invoices stay open until settled (Marc, Oct 22). "Write off balance" settles a short-paid invoice:
-- status → 'paid', the written-off amount and date are kept, and the log gets a 'written_off' event.
-- No data changes; existing rows get null.
alter table public.invoices add column if not exists written_off_amount numeric(12, 2) null
  check (written_off_amount is null or written_off_amount >= 0);
alter table public.invoices add column if not exists written_off_at date null;

alter table public.invoice_events drop constraint if exists invoice_events_kind_check;
alter table public.invoice_events add constraint invoice_events_kind_check
  check (kind in ('drafted', 'finalized', 'download', 'print', 'marked_sent', 'paid', 'short_paid', 'written_off', 'void'));
