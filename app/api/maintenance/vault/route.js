// Maintenance vault API (PR 3). Shop invoices / work orders filed per truck, stored as documents rows with
// doc_type 'maintenance_doc'. Access is decided in SQL (maint_vault_* security definer functions + RLS,
// 20261024000400); every call here runs with the caller's own token. The service client is used only for the
// scan rate-limit log and to remove a deleted document's file from storage after SQL allowed the delete.
//   GET  ?truck=<id>&q=<words>        -> { available, trucks, docs }
//   POST { action: 'add', truckId, filePath, filename, notes } -> { id }   (file already uploaded to the caller's folder)
//   POST { action: 'scan', id, today } -> { suggestion }                 (reads the file; saves NOTHING)
//   POST { action: 'save', id, values: { vendor, date, total, odometer, notes, text, scanned } }
//   POST { action: 'link', id, recordId, values }                       (after the user saved the pre-filled visit)
//   POST { action: 'open', id } -> { url }                              (short-lived signed link)
//   POST { action: 'delete', id }
import { truckCtx, json, isMissing, UUID } from '../../../lib/truckServer.js';
import { serviceClient } from '../../../lib/packetServer.js';
import { runExtraction, RECEIPT_RATE_LIMIT } from '../../../lib/ai-extract.js';
import { saveArgs } from '../../../lib/vaultScan.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BUCKET = 'documents';
const SCAN_MAX = 10 * 1024 * 1024;
const SETUP = { available: false, error: 'The maintenance vault needs a database update that hasn’t been applied yet.', setupNeeded: true };
const CANT_SCAN = 'Couldn’t read this document. Fill in the details by hand.';
const NOT_ALLOWED = 'Only the owner or management can change maintenance documents.';

const sqlErr = (e, fallback) => {
  if (isMissing(e)) return json(SETUP, 503);
  const m = e?.message || '';
  if (/vault_not_allowed|42501/.test(m) || e?.code === '42501') return json({ error: NOT_ALLOWED }, 403);
  if (/bad_file_path/.test(m)) return json({ error: 'Upload the file again.' }, 400);
  if (/record_other_truck/.test(m)) return json({ error: 'That service visit belongs to another truck.' }, 400);
  if (/too_many_receipts/.test(m)) return json({ error: 'That visit already has 10 documents.' }, 400);
  if (/documents_maint_fields_check|check constraint/.test(m)) return json({ error: 'Check the amounts and miles.' }, 400);
  console.error('[maint-vault]', e?.code || '', m.slice(0, 160));
  return json({ error: fallback }, 500);
};

function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export async function GET(req, { deps } = {}) {
  const c = await truckCtx(req, deps);
  if (c.res) return c.res;
  const u = new URL(req.url);
  const truck = u.searchParams.get('truck');
  const q = (u.searchParams.get('q') || '').slice(0, 200);
  const [tr, ls] = await Promise.all([
    c.uc.rpc('maint_vault_trucks'),
    c.uc.rpc('maint_vault_list', { p_truck: truck && UUID.test(truck) ? truck : null, p_q: q || null, p_limit: 200 }),
  ]);
  if (tr.error || ls.error) return sqlErr(tr.error || ls.error, 'Could not load maintenance documents.');
  return json({ available: true, role: c.role, trucks: tr.data || [], docs: ls.data || [], truck: truck && UUID.test(truck) ? truck : null, q });
}

export async function POST(req, { deps } = {}) {
  const c = await truckCtx(req, deps);
  if (c.res) return c.res;
  let b;
  try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const a = b?.action;

  if (a === 'add') {
    if (!UUID.test(b.truckId || '')) return json({ error: 'Pick a truck.' }, 400);
    if (typeof b.filePath !== 'string' || !b.filePath.startsWith(`${c.user.id}/`)) return json({ error: 'Upload the file again.' }, 400);
    const r = await c.uc.rpc('maint_vault_add', { p_truck: b.truckId, p_file_path: b.filePath, p_filename: String(b.filename || 'document').slice(0, 200), p_notes: b.notes ? String(b.notes).slice(0, 1000) : null });
    if (r.error) return sqlErr(r.error, 'Could not file the document.');
    return json({ ok: true, id: r.data });
  }

  if (!UUID.test(b?.id || '')) return json({ error: 'Document not found.' }, 404);
  // RLS: the caller sees the row only if he can see the truck's maintenance.
  const doc = await c.uc.from('documents').select('id, truck_id, file_path, original_filename, doc_type').eq('id', b.id).eq('doc_type', 'maintenance_doc').maybeSingle();
  if (doc.error) return sqlErr(doc.error, 'Could not load the document.');
  if (!doc.data) return json({ error: 'Document not found.' }, 404);

  if (a === 'open') {
    const r = await c.uc.storage.from(BUCKET).createSignedUrl(doc.data.file_path, 300);
    if (r.error || !r.data?.signedUrl) return json({ error: 'Could not open the document.' }, 500);
    return json({ url: r.data.signedUrl });
  }

  const can = await c.uc.rpc('maint_vault_can_manage', { p_doc: b.id });
  if (can.error) return sqlErr(can.error, 'Could not check access.');
  if (!can.data) return json({ error: NOT_ALLOWED }, 403);

  if (a === 'scan') {
    const apiKey = process.env.OPENAI_API_KEY;
    const admin = (deps?.mkService || serviceClient)();
    if (!apiKey || !admin) return json({ error: 'Scanning isn’t set up. Fill in the details by hand.' }, 501);
    const dl = await c.uc.storage.from(BUCKET).download(doc.data.file_path);
    if (dl.error || !dl.data) return json({ error: 'Could not read the stored file.' }, 500);
    if (dl.data.size > SCAN_MAX) return json({ error: 'This file is too large to scan (max 10 MB). Fill in the details by hand.' }, 413);
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const mime = sniffMime(buf);
    if (!mime) return json({ error: 'This file type can’t be scanned (use PDF, JPEG, PNG or WebP). It’s still saved; fill in the details by hand.' }, 415);
    const { data: runId, error: claimErr } = await admin.rpc('claim_extraction_slot', { p_user: c.user.id, p_document: b.id, p_kind: 'receipt' });
    if (claimErr) { console.error('[maint-vault] claim', claimErr.message); return json({ error: CANT_SCAN }, 500); }
    if (!runId) return json({ error: `Scan limit reached (${RECEIPT_RATE_LIMIT.perHour}/hour, ${RECEIPT_RATE_LIMIT.perDay}/day). Fill in the details by hand.` }, 429);
    const today = typeof b.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : undefined;
    const r = await runExtraction('shop_invoice', { apiKey, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, normalizeOpts: { today } });
    await admin.from('extraction_runs').update({ status: r.error ? (r.error.timeout ? 'timeout' : 'error') : 'success' }).eq('id', runId);
    if (r.error) { console.error('[maint-vault] scan', ...(r.error.log || [])); return json({ error: r.error.timeout ? 'Scanning timed out. Fill in the details by hand.' : CANT_SCAN }, 502); }
    console.info('[maint-vault] scanned', JSON.stringify({ services: r.data.services.length, date: !!r.data.date, odo: r.data.odometer != null, total: r.data.total != null }));
    return json({ suggestion: r.data });
  }

  if (a === 'save' || a === 'link') {
    let args;
    try { args = b.values ? saveArgs(b.id, b.values) : null; } catch (e) { return json({ error: e.message }, 400); }
    if (a === 'link') {
      if (!UUID.test(b.recordId || '')) return json({ error: 'Service visit not found.' }, 404);
      const l = await c.uc.rpc('maint_vault_link', { p_doc: b.id, p_record: b.recordId });
      if (l.error) return sqlErr(l.error, 'Could not attach the document to the visit.');
    }
    if (args) {
      const r = await c.uc.rpc('maint_vault_save', args);
      if (r.error) return sqlErr(r.error, 'Could not save the details.');
    }
    return json({ ok: true });
  }

  if (a === 'delete') {
    const r = await c.uc.rpc('maint_vault_delete', { p_doc: b.id });
    if (r.error) return sqlErr(r.error, 'Could not delete the document.');
    const path = r.data;
    if (path) { // the file may sit in another user's folder (e.g. management uploaded it), so the server removes it
      const admin = (deps?.mkService || serviceClient)() || c.uc;
      const rm = await admin.storage.from(BUCKET).remove([path]);
      if (rm.error) console.error('[maint-vault] remove file', rm.error.message);
    }
    return json({ ok: true });
  }

  return json({ error: 'Unknown action.' }, 400);
}
