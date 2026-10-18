// Vault attachments for Send to broker (PR #84, picks 4A, 5B, 6A). Server only (pdf-lib).
// Each vault file goes as its own PDF (6A). JPEG / PNG are wrapped in a one-page PDF; PDFs go as-is.
import { PDFDocument } from 'pdf-lib';
import { groupVault, sendAttachmentOptions, attachmentFilename, checkSendSize } from './companyDocs.js';
import { vaultDocs, vaultPolicies, fileSizes, BUCKET, UUID } from './vaultServer.js';
import { laToday } from './sendCap.js';

const LETTER_W = 612, LETTER_H = 792;
export const sniff = (b) => (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? 'pdf'
  : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg' : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : null);

// → Uint8Array (PDF) | null when the file isn't a PDF, JPEG or PNG.
export async function asPdf(bytes) {
  const kind = sniff(bytes);
  if (kind === 'pdf') return bytes;
  if (kind !== 'jpeg' && kind !== 'png') return null;
  const doc = await PDFDocument.create();
  const img = kind === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const scale = Math.min(1, (LETTER_W - 36) / img.width, (LETTER_H - 36) / img.height);
  const w = img.width * scale, h = img.height * scale;
  const page = doc.addPage([LETTER_W, LETTER_H]);
  page.drawImage(img, { x: (LETTER_W - w) / 2, y: (LETTER_H - h) / 2, width: w, height: h });
  return new Uint8Array(await doc.save());
}

// Draft info for the Send to broker panel: one option per vault type, with sizes for the running total.
export async function vaultSendOptions(sb, ownerId, { profile = null, today = laToday() } = {}) {
  const r = await vaultDocs(sb, ownerId);
  if (r.error) return { options: [], error: true };
  const policies = await vaultPolicies(sb, ownerId);
  const groups = groupVault(r.docs);
  const sizes = await fileSizes(sb, groups.map((g) => g.current?.file_path).filter(Boolean));
  const options = sendAttachmentOptions(groups, { policies, profile, today }).map((o) => {
    const g = groups.find((x) => x.type === o.type);
    return o.available ? { ...o, size: sizes[g.current.file_path] ?? null } : o;
  });
  return { options };
}

// Validates the ids the user ticked and loads the files. Only CURRENT vault versions of this owner are accepted.
// → { attachments: [{ id, type, name, bytes }], ids } | { status, error }
export async function loadVaultAttachments(sb, ownerId, ids, packetBytes) {
  if (ids == null) return { attachments: [], ids: [] };
  if (!Array.isArray(ids) || ids.length > 4 || ids.some((x) => !UUID.test(String(x)))) return { status: 400, error: 'Bad request (attachments). Nothing was sent.' };
  const want = [...new Set(ids.map((x) => String(x).toLowerCase()))];
  if (!want.length) return { attachments: [], ids: [] };
  const r = await vaultDocs(sb, ownerId);
  if (r.error) return { status: 500, error: 'Could not load company documents. Nothing was sent.' };
  const current = groupVault(r.docs).map((g) => g.current).filter(Boolean);
  const picked = want.map((id) => current.find((d) => d.id.toLowerCase() === id));
  if (picked.some((d) => !d)) return { status: 409, error: 'A company document changed since you opened this. Review the attachments again. Nothing was sent.', refresh: true };
  const attachments = [];
  for (const d of picked) {
    const { data: blob } = await sb.storage.from(BUCKET).download(d.file_path);
    if (!blob) return { status: 404, error: `Couldn’t open the ${attachmentFilename(d.doc_type).replace(/\.pdf$/, '')} file. Nothing was sent.` };
    const pdf = await asPdf(new Uint8Array(await blob.arrayBuffer())).catch(() => null);
    if (!pdf) return { status: 422, error: `The ${attachmentFilename(d.doc_type).replace(/\.pdf$/, '')} file isn’t a PDF or photo, so it can’t be attached. Nothing was sent.` };
    attachments.push({ id: d.id, type: d.doc_type, name: attachmentFilename(d.doc_type), bytes: pdf });
  }
  const size = checkSendSize([packetBytes?.length || 0, ...attachments.map((a) => a.bytes.length)]);
  if (!size.ok) return { status: 413, error: size.error, tooLarge: true };
  return { attachments, ids: attachments.map((a) => a.id) };
}
