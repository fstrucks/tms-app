-- loads.status: align the check constraint with the app's statuses.
-- Cause: the loads table was created in prod outside these migrations with
--   loads_status_check = (booked, en_route_pickup, at_pickup, loaded, en_route_delivery, delivered, cancelled),
-- but the app (app/lib/loads.js STATUSES) uses booked, dispatched, in_transit, delivered, invoiced, paid, cancelled.
-- Any status change to dispatched / in_transit / invoiced / paid failed with 23514 and the load detail page showed
-- "Couldn't update the status. Please try again."
-- NOTE: rows still holding en_route_pickup / at_pickup / loaded / en_route_delivery would make the add fail;
-- check with: select status, count(*) from public.loads group by 1;
-- Idempotent: safe to re-run. tests/js/loadsStatusCheck.test.mjs keeps this list equal to STATUSES.
alter table public.loads drop constraint if exists loads_status_check;
alter table public.loads add constraint loads_status_check
  check (status in ('booked','dispatched','in_transit','delivered','invoiced','paid','cancelled'));
