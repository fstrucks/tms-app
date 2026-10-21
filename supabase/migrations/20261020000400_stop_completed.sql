-- Per-stop completion (Home "Current load · Route" card + load page): 'Picked up' / 'Delivered' / 'Done' / 'Skip'.
-- ADDITIVE ONLY, idempotent. The app writes these through /api/loads/:id/stops/:stopId with the service role after
-- checking the caller's company role (owner / management / dispatcher, or the load's assigned driver).
-- stops keep their existing RLS and grants; visible_loads() returns to_jsonb(s), so the new columns flow through.
alter table public.stops add column if not exists completed_at timestamptz;
alter table public.stops add column if not exists completion text;
alter table public.stops add column if not exists completed_by uuid;
alter table public.stops drop constraint if exists stops_completion_check;
alter table public.stops add constraint stops_completion_check
  check ((completed_at is null and completion is null) or (completed_at is not null and completion in ('done', 'skipped')));

notify pgrst, 'reload schema';
