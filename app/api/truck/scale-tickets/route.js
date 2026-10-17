// Scale tickets. POST { action: 'scan' | 'add' | 'confirm' | 'delete', ... }.
//   scan:    { truckId, documentId } → AI reads weight + date → unconfirmed row (upsert on document_id, so a re-scan
//            updates instead of duplicating; a confirmed ticket is never overwritten).
//   add:     { truckId, values, loadId?, documentId? } → manual, confirmed.
//   confirm: { truckId, id, values, loadId? } → user-checked values, confirmed.
//   delete:  { truckId, id }
// Drivers are read-only (403).
import { truckCtx, loadTruckData, ownedTruck, ownedLoad, json, isMissing, SETUP, READ_ONLY_MSG, UUID } from '../../../lib/truckServer';
import { ticketInput } from '../../../lib/truckFields';
import { runExtraction } from '../../../lib/ai-extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function POST(req, { deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  if (!c.canEdit) return json({ error: READ_ONLY_MSG }, 403);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const truck = await ownedTruck(c.db, c.ownerId, b.truckId);
  if (!truck) return json({ error: 'Truck not found.' }, 404);
  const fail = (e, msg) => (isMissing(e) ? json(SETUP, 503) : json({ error: msg }, 500));
  const done = async (extra = {}) => {
    const d = await loadTruckData(c.db, c.ownerId, { truckId: truck.id, userId: c.user.id });
    if (d.setupNeeded) return json(SETUP, 503);
    if (d.error) return json({ error: d.error }, 500);
    return json({ ...d, role: c.role, canEdit: c.canEdit, ...extra });
  };

  if (b.action === 'scan') {
    const apiKey = (deps?.env || process.env).OPENAI_API_KEY;
    if (!UUID.test(b.documentId || '')) return json({ error: 'Bad request.' }, 400);
    // The ticket photo may have been uploaded by the owner or by the team member scanning it.
    const { data: doc } = await c.db.from('documents').select('id,user_id,file_path,doc_type').eq('id', b.documentId).in('user_id', [...new Set([c.ownerId, c.user.id])]).maybeSingle();
    if (!doc?.file_path) return json({ error: 'Document not found.' }, 404);
    const { data: existing } = await c.db.from('scale_tickets').select('*').eq('user_id', c.ownerId).eq('document_id', doc.id).maybeSingle();
    if (existing?.confirmed) return done({ ticketId: existing.id, note: 'That ticket is already in the history.' });
    if (!apiKey) return done({ readError: 'The ticket reader isn’t set up. Enter the weight by hand.', documentId: doc.id });
    const mime = TYPES[String(doc.file_path.split('.').pop() || '').toLowerCase()];
    if (!mime) return json({ error: 'The reader handles PDF, JPG, PNG or WEBP files.' }, 415);
    const { data: blob } = await c.db.storage.from('documents').download(doc.file_path);
    if (!blob) return json({ error: 'Could not open the ticket.' }, 404);
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length > MAX_BYTES) return json({ error: 'That file is too large for the reader (10 MB max).' }, 413);
    const r = await (deps?.runExtraction || runExtraction)('scale_ticket', { apiKey, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
    if (r.error) { console.error('[truck] scale read', ...(r.error.log || [])); return done({ readError: 'Couldn’t read that ticket. Enter the weight by hand.', documentId: doc.id }); }
    const t = r.data || {};
    if (!t.is_scale_ticket || !t.gross_weight_lb) return done({ readError: 'That doesn’t look like a scale ticket, or the weight wasn’t readable. Enter it by hand.', read: t, documentId: doc.id });
    const row = { ticket_date: t.ticket_date || new Date().toISOString().slice(0, 10), gross_weight_lb: t.gross_weight_lb, steer_axle_lb: t.steer_axle_lb, drive_axle_lb: t.drive_axle_lb,
      trailer_axle_lb: t.trailer_axle_lb, scale_name: t.scale_name, source: 'ai', confirmed: false, trailer_id: truck.current_trailer_id || null };
    const w = existing
      ? await c.db.from('scale_tickets').update(row).eq('id', existing.id).eq('user_id', c.ownerId).eq('confirmed', false).select('id').maybeSingle()
      : await c.db.from('scale_tickets').insert({ ...row, user_id: c.ownerId, truck_id: truck.id, document_id: doc.id }).select('id').single();
    if (w.error?.code === '23505') { const again = await c.db.from('scale_tickets').select('id').eq('user_id', c.ownerId).eq('document_id', doc.id).maybeSingle(); return done({ ticketId: again.data?.id, dateMissing: !t.ticket_date }); }
    if (w.error) return fail(w.error, 'Could not save the ticket.');
    return done({ ticketId: w.data?.id || existing?.id, dateMissing: !t.ticket_date });
  }

  if (b.action === 'add' || b.action === 'confirm') {
    const v = ticketInput(b.values); if (v.error) return json({ error: v.error }, 422);
    if (!(await ownedLoad(c.db, c.ownerId, b.loadId || null))) return json({ error: 'Load not found.' }, 404);
    const row = { ...v.patch, load_id: b.loadId || null, confirmed: true };
    if (b.action === 'add') {
      let documentId = null; // optional: the scanned photo when the reader couldn't read it
      if (b.documentId) {
        if (!UUID.test(b.documentId)) return json({ error: 'Document not found.' }, 404);
        const { data: doc } = await c.db.from('documents').select('id').eq('id', b.documentId).in('user_id', [...new Set([c.ownerId, c.user.id])]).maybeSingle();
        if (!doc) return json({ error: 'Document not found.' }, 404);
        documentId = doc.id;
      }
      const r = await c.db.from('scale_tickets').insert({ ...row, user_id: c.ownerId, truck_id: truck.id, trailer_id: truck.current_trailer_id || null, document_id: documentId, source: 'manual' }).select('id').single();
      if (r.error) return fail(r.error, 'Could not add the ticket.');
      return done({ ticketId: r.data.id });
    }
    if (!UUID.test(b.id || '')) return json({ error: 'Ticket not found.' }, 404);
    const r = await c.db.from('scale_tickets').update(row).eq('id', b.id).eq('user_id', c.ownerId).eq('truck_id', truck.id).select('id').maybeSingle();
    if (r.error) return fail(r.error, 'Could not save the ticket.');
    if (!r.data) return json({ error: 'Ticket not found.' }, 404);
    return done({ ticketId: b.id });
  }

  if (b.action === 'delete') {
    if (!UUID.test(b.id || '')) return json({ error: 'Ticket not found.' }, 404);
    const r = await c.db.from('scale_tickets').delete().eq('id', b.id).eq('user_id', c.ownerId).eq('truck_id', truck.id).select('id');
    if (r.error) return fail(r.error, 'Could not remove the ticket.');
    if (!r.data?.length) return json({ error: 'Ticket not found.' }, 404);
    return done();
  }
  return json({ error: 'Bad request.' }, 400);
}
