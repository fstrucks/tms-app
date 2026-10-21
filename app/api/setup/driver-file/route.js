import { driverFileRows, buildChecklist, modelFromPayload } from '../../../lib/setupProgress.js';
import { buildDriverFilePdf, driverFileAttachments } from '../../../lib/driverFilePdf.js';
import { json, setupCtx, loadSetup, BUCKET, UUID } from '../../../lib/setupServer.js';
import { laToday } from '../../../lib/sendCap.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export async function GET(req) {
  const c = await setupCtx(req);
  if (c.res) return c.res;
  if (!c.office) return json({ error: 'Only the office can download a driver file.' }, 403);
  const driverId = new URL(req.url).searchParams.get('driverId');
  if (!UUID.test(driverId || '')) return json({ error: 'Pick a driver.' }, 422);
  const data = await loadSetup(c);
  if (data.error) return json({ error: data.error }, 500);
  if (data.setupNeeded) return json({ error: 'The checklist needs a database update that hasn’t been applied yet.' }, 503);
  if (!c.db) return json({ error: 'Driver files aren’t available for teammates right now.' }, 503);
  const driver = (data.drivers || []).find((d) => d.id === driverId);
  if (!driver) return json({ error: 'Driver not found.' }, 404);
  const today = data.today || laToday();
  const rows = driverFileRows(driverId, buildChecklist(modelFromPayload(data, today)));
  const metas = driverFileAttachments(data.documents, driverId);
  const files = [];
  for (const doc of metas) {
    if (!doc.file_path) continue;
    const got = await c.db.storage.from(BUCKET).download(doc.file_path);
    if (got.error || !got.data) { files.push({ name: doc.original_filename || 'File', docType: doc.doc_type, bytes: null }); continue; }
    const bytes = new Uint8Array(await got.data.arrayBuffer());
    files.push({ name: doc.original_filename || 'File', docType: doc.doc_type, contentType: got.data.type || '', bytes });
  }
  const pdf = await buildDriverFilePdf({
    companyName: data.profile?.legal_name || data.profile?.dba_name || 'Company',
    usdot: data.profile?.dot_number || '',
    driverName: driver.name,
    rows, files, date: today,
  });
  const safe = String(driver.name || 'driver').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'driver';
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="driver-file-${safe}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
