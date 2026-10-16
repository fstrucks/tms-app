// Next 14 patches global fetch on the server and caches GET responses (the Data Cache), keyed by URL +
// headers. supabase-js reads are GETs, so without this a route can get a stale copy of an earlier read:
// /api/company-profile kept returning the "no profile yet" answer from before the first save.
// Pass to createClient(..., { global: { fetch: noStoreFetch } }) in every server route.
export const noStoreFetch = (input, init = {}) => fetch(input, { ...init, cache: 'no-store' });
