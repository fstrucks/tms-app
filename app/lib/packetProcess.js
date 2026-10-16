// Server: run detection → naming → save packet_fields for one packet, within a time budget (Vercel 60s).
// Injected: sb (service-role client), reader, extract. Safe to call twice: the claim is atomic.
import { extractPdf, MAX_PAGES } from './packetPdfText.js';
import { buildPacketFields } from './packetFields.js';
import { createPacketReader } from './packetReader.js';
import { isMissingSchema, MISSING_MSG, MIGRATION } from './packetServer.js';

export const BUDGET_MS = 45_000; // leaves headroom under maxDuration 60
export const STALE_MS = 5 * 60_000; // a 'processing' claim older than this can be retried

export async function claimPacket(sb, packetId, { force = false, now = Date.now() } = {}) {
  const iso = new Date(now).toISOString();
  let q = sb.from('packets').update({ status: 'processing', processing_started_at: iso, process_error: null, updated_at: iso }).eq('id', packetId);
  q = force ? q.in('status', ['received', 'error', 'review', 'processing']) : q.or(`status.in.(received,error),and(status.eq.processing,processing_started_at.lt.${new Date(now - STALE_MS).toISOString()})`);
  const { data, error } = await q.select('id,owner_id,file_path').maybeSingle();
  if (error && isMissingSchema(error)) { const e = new Error(MISSING_MSG); e.setupNeeded = true; throw e; }
  if (error) throw new Error('claim failed: ' + (error.code || error.message));
  return data; // null = someone else has it, or already processed
}

export async function processPacket({ sb, packetId, force = false, reader = createPacketReader(), extract = extractPdf, budgetMs = BUDGET_MS, now = Date.now }) {
  const start = now();
  let pk;
  try { pk = await claimPacket(sb, packetId, { force, now: start }); } catch (e) {
    if (e.setupNeeded) { console.error('[packets] process skipped: migration missing', MIGRATION); return { setupNeeded: true, error: e.message, migration: MIGRATION }; } // packet stays 'received'
    throw e;
  }
  if (!pk) return { skipped: true };
  const finish = (patch) => sb.from('packets').update({ ...patch, processed_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() }).eq('id', packetId);
  try {
    const { data: file, error: dErr } = await sb.storage.from('documents').download(pk.file_path);
    if (dErr || !file) throw new Error('download failed: ' + (dErr?.message || 'no file').slice(0, 120));
    const bytes = Buffer.from(await file.arrayBuffer());
    let ex;
    try { ex = await extract(bytes, { deadline: start + budgetMs * 0.5 }); } catch (e) {
      // Couldn't read the PDF (damaged, encrypted, or a reader problem): never dead-end the user — manual mapping.
      console.error('[packets] read failed', String(e?.message || e).slice(0, 200));
      await finish({ status: 'review', manual_reason: 'reader_error', process_error: String(e?.message || e).slice(0, 200) });
      return { manual: 'reader_error', fields: 0 };
    }
    const base = { page_count: ex.pageCount, has_text_layer: ex.hasText };
    if (!ex.hasText) { await finish({ ...base, status: 'review', manual_reason: 'no_text_layer' }); return { manual: 'no_text_layer', fields: 0 }; }
    // Naming gets what's left of the budget; on timeout we keep the unnamed local fields.
    const left = start + budgetMs - now();
    const timed = { enabled: reader.enabled, nameFields: (f) => {
      let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(1000, left)); });
      return Promise.race([reader.nameFields(f), to]).finally(() => clearTimeout(t));
    } };
    const { rows, summary } = await buildPacketFields({ packetId, ownerId: pk.owner_id, pages: ex.pages, reader: timed });
    const sizes = new Map(ex.pages.map((p) => [p.page, p.size]));
    const full = rows.map((r) => ({ ...r, page_w: sizes.get(r.page)?.[0] ?? null, page_h: sizes.get(r.page)?.[1] ?? null }));
    // Replace only machine-made rows; user-made/edited rows are kept on a re-run.
    await sb.from('packet_fields').delete().eq('packet_id', packetId).in('source', ['local', 'model']);
    if (full.length) {
      const { error } = await sb.from('packet_fields').upsert(full, { onConflict: 'packet_id,field_key', ignoreDuplicates: true });
      if (error) throw new Error('save fields failed: ' + (error.code || error.message));
    }
    const manual = ex.truncated ? 'too_many_pages' : summary.error === 'timeout' ? 'timeout' : summary.error ? 'reader_error' : !full.length ? 'no_fields' : null;
    await finish({ ...base, status: 'review', manual_reason: manual });
    return { fields: full.length, named: summary.named, low_confidence: summary.low_confidence, manual };
  } catch (e) {
    await finish({ status: 'error', process_error: String(e.message).slice(0, 200) });
    return { error: e.message };
  }
}
export { MAX_PAGES };
