# Load map + calculated truck miles (PR B)

- **Map** at the top of the load page: Leaflet with OpenStreetMap tiles, pickup (P) and delivery (D) pins and the
  truck route line. Lazy-loaded (next/dynamic, ssr off). On phones one finger scrolls the page; pinch or +/− zooms.
  Attribution: "© openrouteservice by HeiGIT | © OpenStreetMap contributors".
- **Server only** (`/api/loads/[id]/map`, `app/lib/loadRouteServer.js`): ORS_API_KEY never reaches the browser.
  - Geocoding: `https://api.heigit.org/pelias/v1/search/structured` (street + city + state + zip, country US/CA),
    then free text `/pelias/v1/search`. Street-level hit (confidence ≥ 0.5) = 'street'; city/ZIP centroid = 'city'.
    A match in another state (both 2-letter codes) is rejected. Saved on stops: lat, lng, geocoded_at,
    geocode_address, geocode_precision ('street' | 'city').
  - Route: `POST https://api.heigit.org/openrouteservice/v2/directions/driving-hgv`, units=mi. Saved on loads:
    calculated_miles, route_geometry (simplified polyline), route_key, route_computed_at, route_error.
- **Caching**: GET never calls ORS. The page POSTs only when the server says the route is stale: never computed,
  stop addresses changed (route_key), or a temporary failure's cool-down (10 min) is over. A geocode miss or "no
  route" is not retried until an address changes.
- **Limits** (free plan: directions 2,000/day, 40/min; geocoding 1,000/day, 100/min): per-instance limiter at
  30/min + 1,800/day (directions) and 80/min + 900/day (geocoding), plus a database-wide count of route attempts
  in the last minute / UTC day. 429s are saved as `rate_limited` and retried after the cool-down.
- **Planned miles**: typed > rate con > calculated. Calculated only fills total_miles when it's empty or already
  'calculated' (miles_source='calculated'). When rate con and route miles differ by more than 10%, the Miles card
  shows "Calculated N mi" with **Use this** (saves miles_source='calculated').
- **Failures**: no key → "The map and route miles aren't set up yet."; before the migration → a one-line note and
  no ORS calls; geocode miss → pins what was found + which address to check; busy/timeout → "tried again in a few minutes".
- Migration `20261018000400_load_route_map.sql` (not applied by the PR; run after 20261018000300).

## Short steps (QA #83)
- Each POST does ONE step: geocode one stop (≤ 2 calls × 6 s), record a miss, or fetch the route (18 s timeout),
  inside a 22 s budget; `maxDuration = 30`. The page calls POST again while the answer has `next` (max 8 steps).
- Every path answers JSON (try/catch around the handler). Auth: Bearer token, with the fields-API fallback (database
  verifies the token when Supabase Auth can't answer). The app keeps the session in the browser's storage, not a
  cookie, so opening the API URL directly in a tab returns 401 "Sign in first" by design.
- A remembered miss (geocode_address set, no lat/lng) isn't looked up again until the address changes.
