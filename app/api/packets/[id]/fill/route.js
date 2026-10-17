import { serviceClient, packetAccess, isMissingSchema } from '../../../../lib/packetServer';
import { filledPath, SIGN_MIGRATION } from '../../../../lib/packetSign';
import { resolveFillValues } from '../../../../lib/packetFillValues';
import { fillPacket } from '../../../../lib/packetFill';
import { decryptField, loadKey, PacketKeyError } from '../../../../lib/packetCrypto';
import { learnFromFill } from '../../../../lib/packetLayouts';
import { waitUntil } from '@vercel/functions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 60;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

// Builds the filled PDF (text values + signature images), saves it as a new file under the owner's
// packets/filled/ folder, and returns a short-lived download link. Editors only. Bank/EIN decrypted here only.
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!a.canEdit) return json({ error: 'Only the owner, dispatcher or management can fill packets.' }, 403);
  const { data: rows, error } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id);
  if (error) return json({ error: 'Could not load fields.' }, 500);
  if (!rows?.length) return json({ error: 'Add fields before filling the packet.' }, 400);
  const unconfirmed = rows.filter((r) => r.needs_confirm && !r.confirmed_at);
  if (unconfirmed.length) return json({ error: 'Confirm the bank numbers before filling the packet.', fieldIds: unconfirmed.map((r) => r.id) }, 409);
  const { data: profile } = await sb.from('company_profiles').select('*').eq('owner_id', a.packet.owner_id).maybeSingle();
  const images = {};
  for (const p of new Set(rows.map((r) => r.signature_path).filter(Boolean))) {
    const { data } = await sb.storage.from('documents').download(p);
    if (data) images[p] = await blobBytes(data);
  }
  let resolved;
  try {
    let key = null; const decrypt = (c) => decryptField(c, key || (key = deps?.key || loadKey()));
    resolved = resolveFillValues(rows, profile, { decrypt, images });
  } catch (e) {
    if (e instanceof PacketKeyError) return json({ error: 'Bank and EIN numbers cannot be filled until the encryption key is configured.' }, 503);
    console.error('[packets] fill decrypt', e.message); return json({ error: 'Could not read a saved bank or EIN number.' }, 500);
  }
  if (resolved.missing.length && !deps?.allowUnsigned && new URL(req.url).searchParams.get('unsigned') !== '1') {
    return json({ error: resolved.missing.length === 1 ? 'Sign the signature field first.' : `Sign all ${resolved.missing.length} signature fields first.`, missing: resolved.missing }, 409);
  }
  const { data: src } = await sb.storage.from('documents').download(a.packet.file_path);
  if (!src) return json({ error: 'Could not open the packet PDF.' }, 404);
  let out;
  try { out = await fillPacket(await blobBytes(src), resolved.fields); }
  catch (e) { console.error('[packets] fill', e.message); return json({ error: 'Could not fill this PDF.' }, 500); }
  const path = filledPath(a.packet.owner_id, a.packet.id, deps?.ts);
  const { error: upErr } = await sb.storage.from('documents').upload(path, out.bytes, { contentType: 'application/pdf', upsert: false });
  if (upErr) { console.error('[packets] fill upload', upErr.message); return json({ error: 'Could not save the filled PDF.' }, 500); }
  const { error: pErr } = await sb.from('packets').update({ filled_path: path, filled_at: new Date().toISOString(), filled_by: a.user.id }).eq('id', a.packet.id);
  if (pErr && !isMissingSchema(pErr)) console.error('[packets] fill record', pErr.code);
  const name = `${String(a.packet.original_filename || a.packet.subject || 'packet').replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60)}-filled.pdf`;
  const { data: link } = await sb.storage.from('documents').createSignedUrl(path, 600, { download: name });
  // Remember this broker's layout (positions + names only; never values, bank/EIN data or signatures). Never fails the fill.
  // Runs after the response (waitUntil) so the download link is never held up; tests inject and await it.
  const learnJob = (async () => (deps?.learn || learnFromFill)(sb, { packet: a.packet, rows, userId: a.user.id,
    pdfBytes: a.packet.fingerprint ? null : await blobBytes(src).catch(() => null) }))().catch((e) => { console.error('[packets] learn', e?.message); return { action: 'skip' }; });
  let learned = { action: 'pending' };
  if (deps?.awaitLearn) learned = await learnJob; else (deps?.waitUntil || waitUntil)(learnJob);
  return json({ ok: true, path, drawn: out.drawn, url: link?.signedUrl || null, filename: name, recorded: !pErr, layout: { action: learned?.action || 'skip', version: learned?.version ?? null }, ...(pErr && isMissingSchema(pErr) ? { migration: SIGN_MIGRATION } : {}) });
}
