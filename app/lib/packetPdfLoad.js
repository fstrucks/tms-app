// Client: PDF bytes for /packets/[id] via the server. Signed URL first (any size), then the
// authenticated ?raw=1 route. Never throws; returns { data } or { error } so the page can't hang.
export async function loadPacketPdf(id, { call, getToken, get = (...a) => fetch(...a) }) {
  const f = await call(`/api/packets/${id}/file`);
  if (f.error && (f.status === 401 || f.status === 403 || f.status === 404)) return { error: f.error };
  if (!f.error && f.url) {
    try {
      const r = await get(f.url, { cache: 'no-store' });
      if (r.ok) return { data: new Uint8Array(await r.arrayBuffer()) };
      console.error('[packet] signed url', r.status);
    } catch (e) { console.error('[packet] signed url', e); }
  }
  try {
    const t = await getToken(); if (!t) return { error: 'Sign in again.' };
    const r = await get(`/api/packets/${id}/file?raw=1`, { cache: 'no-store', headers: { Authorization: `Bearer ${t}` } });
    if (r.ok) return { data: new Uint8Array(await r.arrayBuffer()) };
    const j = await r.json().catch(() => ({}));
    return { error: j.error || `Could not open the PDF (${r.status}).` };
  } catch { return { error: 'Could not open the PDF. Check your connection and reload.' }; }
}
