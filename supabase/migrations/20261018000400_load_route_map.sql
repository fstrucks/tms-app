-- PR B, load map + calculated truck miles (Marc approved Oct 18; OpenRouteService + Leaflet/OpenStreetMap). NOT APPLIED by this PR.
-- Run after 20261018000300_load_miles_source.sql (PR A). Idempotent: safe to re-run. Adds columns only: no new tables,
-- no backfill, no existing values change. Nothing is geocoded or routed until someone opens a load page.
--
-- stops: where each stop is on the map (filled by the server from OpenRouteService geocoding, cached).
--   lat / lng          the point used for the pin and the route
--   geocoded_at        when it was looked up
--   geocode_address    the address text that was looked up; when the stop's address changes, it is looked up again
--   geocode_precision  'street' (street address matched) or 'city' (fell back to city, state, zip)
-- loads: the cached truck route.
--   calculated_miles   truck (driving-hgv) route miles; kept separate from total_miles (Planned)
--   route_key          fingerprint of the stop addresses the route was made from; a change means recompute
--   route_geometry     the route line (encoded polyline, simplified) for the map
--   route_computed_at  last attempt (success or failure); used for retry cool-downs
--   route_error        null when fine, else a short code (geocode_miss, no_route, rate_limited, upstream, bad_key)
-- Planned miles precedence (typed > rate con > calculated) is enforced by the app: calculated miles only fill
-- total_miles when it is empty or already 'calculated' (miles_source from PR A).

alter table public.stops add column if not exists lat double precision;
alter table public.stops add column if not exists lng double precision;
alter table public.stops add column if not exists geocoded_at timestamptz;
alter table public.stops add column if not exists geocode_address text;
alter table public.stops add column if not exists geocode_precision text;
alter table public.stops drop constraint if exists stops_geocode_precision_check;
alter table public.stops add constraint stops_geocode_precision_check
  check (geocode_precision is null or geocode_precision in ('street', 'city'));
alter table public.stops drop constraint if exists stops_lat_lng_check;
alter table public.stops add constraint stops_lat_lng_check
  check ((lat is null or lat between -90 and 90) and (lng is null or lng between -180 and 180));

alter table public.loads add column if not exists calculated_miles integer;
alter table public.loads add column if not exists route_key text;
alter table public.loads add column if not exists route_geometry text;
alter table public.loads add column if not exists route_computed_at timestamptz;
alter table public.loads add column if not exists route_error text;
alter table public.loads drop constraint if exists loads_calculated_miles_check;
alter table public.loads add constraint loads_calculated_miles_check
  check (calculated_miles is null or calculated_miles > 0);

-- stops already have a table-level UPDATE grant (0400). loads UPDATE is column-granted (0600): add the route
-- columns so the owner's own sign-in (used by the server route, row security still applies) can save them.
grant update (calculated_miles, route_key, route_geometry, route_computed_at, route_error) on public.loads to authenticated;

notify pgrst, 'reload schema';
