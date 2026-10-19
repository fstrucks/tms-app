# Home card: swipeable map panel with miles left, Drive time and ETA

Plan: `/workspace/powerhaul-docs/2026-10-18_current-load-eta_plan.md` (Marc approved Oct 18, 9:49 PM CT).

- **Panels** (`app/components/CurrentLoadPanels.js`): Panel 1 = the existing front card (unchanged); Panel 2 = map.
  CSS scroll-snap swipe, ‹ › arrows + dots under the card, WAI-ARIA tabs "Load | Map" (← → Home End), inactive
  panel `inert`, reduced-motion respected. Only for the *current* load (in transit / dispatched), not "Next load".
- **Lazy**: Panel 2 (and Leaflet, tiles, API calls, the location check) mounts only after it is first shown.
- **Panel 2** (`app/components/LoadMapPanel.js`): reused `RouteMap` (OSM tiles, light in dark mode) with the stored
  load route, a truck dot and the live leg; "312 mi left to delivery", **Drive time**, **ETA** (now + drive time, in
  the stop's time zone, else the device's), "Ideal conditions: no traffic, breaks or fuel stops."
  Navigate: Trucker Path (phones), Google Maps, Apple Maps, Copy address.
- **API** `app/api/loads/[id]/eta` (`app/lib/loadEtaServer.js`): GET = stops + stored route (no ORS call);
  POST `{ lat, lng, accuracy_m, stop_id }` (body only) → ORS driving-hgv from the origin rounded to 2 decimals.
  Access through `visible_loads(p_load)`, so drivers reach only their assigned loads. 10-min in-memory cache,
  ≤ 1 call / 3 min and ≤ 60 / day per user, ETA bucket 20/min + 1,200/day inside the shared directions limiter.
- **Refresh** (`app/lib/loadEta.js`): location read every 60 s only while Panel 2 is showing and the page is visible;
  route on first view, after ≥ 10 mi + ≥ 10 min, every 20 min while moving, Refresh (2-min floor); never parked or
  within 1 mi of the stop. Between calls the numbers are scaled by straight-line progress.
- **Privacy**: driver location is never stored (no SQL, no writes) or logged; memory only in the browser.
- **Fallbacks**: not asked → "Use my location"; denied/unsupported → total route miles + how to turn it on;
  timeout/busy/quota → last good answer up to 60 min, retry after 10 min; no_route → retry after moving 2 mi;
  no key → total miles only; stop without a map pin → "check its address".
- **Trucker Path**: documented URL Launcher Schema takes coordinates only (no addresses):
  iOS `truckerpath://cal_route?daddr=LAT,LNG` (App Store if the app didn't open after 1.5 s);
  Android `intent://cal_route?d_addr=LAT,LNG#Intent;scheme=truckerpath;package=com.sixdays.truckerpath;S.browser_fallback_url=…`
  (Play Store fallback built in). Hidden on desktop and when the stop has no map pin (Copy address still works).
