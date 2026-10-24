// Match an emailed rate con to a load already in the same account.
// Broker load numbers match after trim, case-insensitive. Nothing here writes a load.

export function normalizeBrokerLoadNumber(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Loads whose broker_load_number equals loadNumber under that normalization.
export function existingLoadMatches(loads, loadNumber) {
  const want = normalizeBrokerLoadNumber(loadNumber);
  if (!want) return [];
  return (loads || []).filter((l) => l?.id && normalizeBrokerLoadNumber(l.broker_load_number) === want);
}

// The load already on the books: oldest created_at, then id. Null when nothing matches.
export function pickExistingLoad(loads, loadNumber) {
  const hits = existingLoadMatches(loads, loadNumber);
  if (!hits.length) return null;
  return [...hits].sort((a, b) => {
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

// Needs attention review: a draft with no load yet, whose read load number matches one of these loads.
export function reviewLoadMatch(doc, loads) {
  if (!doc || doc.load_id) return null;
  return pickExistingLoad(loads, doc.ai_extracted_data?.load_number);
}

// Button label. X is the load's own broker load number, as stored (trimmed).
export function linkExistingLoadLabel(load) {
  const num = String(load?.broker_load_number ?? '').trim();
  return num ? `Link to existing load #${num}` : 'Link to existing load';
}

export function escapeIlike(s) {
  return String(s || '').replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

// PATCH the document onto an existing load. The body is only { loadId }. The load row is not sent.
export async function linkDocumentToExistingLoad(fetchImpl, { docId, loadId, token }) {
  let res;
  try {
    res = await fetchImpl(`/api/documents/${docId}/load`, {
      method: 'PATCH',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ loadId }),
    });
  } catch {
    return { ok: false, error: 'Couldn’t reach the server. Not linked.' };
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: j.error || 'Couldn’t link the document.' };
  return { ok: true, loadId: j.document?.load_id || loadId };
}
