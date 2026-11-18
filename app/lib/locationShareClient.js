// Browser side: after ANY browser-side write that moves a load to delivered, tell the server so a share tied to the load
// ends now (the server also sweeps on read, so a missed call only delays it by one refetch). Best effort, never throws.
export const LOAD_DELIVERED_PATH = '/api/location-share/load-delivered';
export async function notifyLoadDeliveredClient(supabase, loadId, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!loadId) return false;
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return false;
    const res = await fetchImpl(LOAD_DELIVERED_PATH, { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ load_id: loadId }) });
    try { window.dispatchEvent(new Event('ph-location-share')); } catch { /* no window (tests) */ }
    return !!res?.ok;
  } catch { return false; }
}
