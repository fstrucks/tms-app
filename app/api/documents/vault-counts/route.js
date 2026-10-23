// GET /api/documents/vault-counts — tile counts only. The maintenance tile is counted elsewhere, and only when that tile is shown.
import { loadDocsCtx, json } from '../../../lib/loadDocsServer';
import { vaultTileCounts } from '../../../lib/vaultCounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await loadDocsCtx(req, deps);
  if (x.res) return x.res;
  const { c, svc } = x;
  const prof = await svc.from('company_profiles').select('id,owner_id').eq('owner_id', c.ownerId).limit(1);
  const profileId = prof.data?.[0]?.id || null;
  const counts = await vaultTileCounts(svc, { ownerId: c.ownerId, role: c.role, userId: c.user.id, profileId });
  if (counts.error) return json({ error: 'Couldn’t count documents.' }, 500);
  return json({
    loadDocs: counts.loadDocs,
    driverDocs: counts.driverDocs,
    driverDocsCapped: counts.driverDocsCapped,
    companyDocs: counts.companyDocs,
  });
}
