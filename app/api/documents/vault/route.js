// GET /api/documents/vault?load=&broker=&type=&from=&to=&cursor=
// One page of load paperwork the caller may already see. Does not return the whole table.
import { loadDocsCtx, json } from '../../../lib/loadDocsServer';
import { docTypeLabel } from '../../../lib/docTypes';
import { isImagePath, loadPickLabel } from '../../../lib/loadDocs';
import { fetchVaultPage } from '../../../lib/loadVaultQuery';
import { DATE_RANGE_ERROR, normalizeFilters, parseCursor, reversedDateRange } from '../../../lib/loadVault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const labelFor = (t) => (t ? docTypeLabel(t) : 'Rate confirmation');

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

export async function GET(req, { deps } = {}) {
  const x = await loadDocsCtx(req, deps);
  if (x.res) return x.res;
  const { c, svc } = x;
  const sp = new URL(req.url).searchParams;
  const raw = { load: sp.get('load'), broker: sp.get('broker'), type: sp.get('type'), from: sp.get('from'), to: sp.get('to') };
  if (reversedDateRange(raw)) return json({ documents: [], nextCursor: null, dateError: DATE_RANGE_ERROR });
  const filters = normalizeFilters(raw);
  const cursor = parseCursor(sp.get('cursor') || '');
  const page = await fetchVaultPage(svc, { ownerId: c.ownerId, role: c.role, userId: c.user.id, filters, cursor, limit: 20 });
  if (page.error) return json({ error: 'Couldn’t load these documents.' }, 500);
  const urls = await urlMap(svc, page.rows.map((r) => r.doc));
  return json({
    role: c.role,
    nextCursor: page.nextCursor,
    documents: page.rows.map(({ doc, load }) => {
      const xdata = doc.ai_extracted_data && typeof doc.ai_extracted_data === 'object' ? doc.ai_extracted_data : {};
      const own = doc.user_id === c.user.id;
      return {
        id: doc.id,
        doc_type: doc.doc_type,
        label: labelFor(doc.doc_type),
        original_filename: doc.original_filename,
        created_at: doc.created_at,
        load_id: load?.id || null,
        load_label: load ? loadPickLabel(load) : null,
        broker: load?.broker_name || xdata.broker_name || null,
        load_number: load?.broker_load_number || xdata.load_number || null,
        own,
        file_path: own ? doc.file_path : undefined,
        url: urls.get(doc.file_path) || null,
        isImage: isImagePath(doc.file_path),
      };
    }),
  });
}
