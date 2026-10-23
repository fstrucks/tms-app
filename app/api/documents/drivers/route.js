// GET /api/documents/drivers — driver files grouped per driver.
// Drivers only receive the driver row linked to their sign-in. Office roles see every driver.
import { loadDocsCtx, json } from '../../../lib/loadDocsServer';
import { docTypeLabel } from '../../../lib/docTypes';
import { isImagePath } from '../../../lib/loadDocs';
import { loadDriverVault } from '../../../lib/driverVaultQuery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function urlMap(svc, docs) {
  const paths = docs.map((d) => d.file_path).filter(Boolean);
  if (!paths.length) return new Map();
  try {
    const signed = await svc.storage.from('documents').createSignedUrls(paths, 600);
    return new Map((signed?.data || []).map((u) => [u.path, u.signedUrl]));
  } catch {
    return new Map();
  }
}

function shape(doc, me, urls) {
  return {
    id: doc.id,
    doc_type: doc.doc_type,
    label: doc.doc_type ? docTypeLabel(doc.doc_type) : 'Document',
    original_filename: doc.original_filename,
    created_at: doc.created_at,
    url: urls.get(doc.file_path) || null,
    isImage: isImagePath(doc.file_path),
    own: doc.user_id === me,
  };
}

export async function GET(req, { deps } = {}) {
  const x = await loadDocsCtx(req, deps);
  if (x.res) return x.res;
  const { c, svc } = x;
  const prof = await svc.from('company_profiles').select('id,owner_id').eq('owner_id', c.ownerId).limit(1);
  const profileId = prof.data?.[0]?.id || null;
  const got = await loadDriverVault(svc, { ownerId: c.ownerId, role: c.role, userId: c.user.id, profileId });
  if (got.error) return json({ error: 'Couldn’t load driver files.' }, 500);
  const files = [...(got.groups || []).flatMap((g) => g.files), ...(got.unassigned || [])];
  const urls = await urlMap(svc, files);
  return json({
    role: c.role,
    unavailable: !!got.unavailable,
    capped: !!got.capped,
    drivers: (got.groups || []).map((g) => ({ ...g.driver, files: g.files.map((d) => shape(d, c.user.id, urls)) })),
    unassigned: (got.unassigned || []).map((d) => shape(d, c.user.id, urls)),
  });
}
