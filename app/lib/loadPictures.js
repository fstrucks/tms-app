// Load pictures: gallery photos stored as documents rows (doc_type load_picture) in the documents bucket.
// documents.doc_type is plain text with no check constraint, so this needs no SQL.
// Big phone photos are resized in the browser (longest side 2000px, JPEG 0.8, EXIF orientation baked in).
// There is no shared reencodeJpeg; receipts do the same canvas encode inline in app/expenses/page.js.
import { authedFetch } from './authedFetch';
import { LOAD_PICTURE_TYPE } from './docTypes';
import { deleteDocument } from './documents';

export { LOAD_PICTURE_TYPE };
export const PICTURE_BATCH_MAX = 10;
export const PICTURE_MAX_EDGE = 2000;
export const PICTURE_JPEG_QUALITY = 0.8;
export const PICTURE_MAX_BYTES = 10 * 1024 * 1024; // documents bucket file_size_limit
export const PICTURE_RAW_MAX = 40 * 1024 * 1024;
// storage.buckets documents.allowed_mime_types. Anything else must be re-encoded to JPEG.
export const PICTURE_STORED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const EXT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', avif: 'image/avif',
};

const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

export function jpegName(name) {
  const base = String(name || 'picture').replace(/\.[^.]+$/, '').replace(/^\.+/, '') || 'picture';
  return `${base}.jpg`;
}

// Declared image type, or the extension when the phone leaves the type empty (HEIC on Android).
export function resolveImageType(file) {
  const name = String(file?.name || '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (ext === 'svg' || type.includes('svg')) return 'image/svg+xml';
  if (type.startsWith('image/')) return type;
  if (!type || type === 'application/octet-stream') return EXT_TYPES[ext] || '';
  return '';
}

export function isPictureFile(file) {
  const type = resolveImageType(file);
  return type.startsWith('image/') && !type.includes('svg');
}

const isHeic = (file, type) => type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(file?.name || '');

export function pictureFileError(file) {
  if (!file) return 'Choose a picture.';
  if (!isPictureFile(file)) return 'Pictures only. Choose a photo.';
  if (!file.size) return 'This picture is empty.';
  if (file.size > PICTURE_RAW_MAX) return `This picture is too large (${mb(file.size)}). Maximum is 40 MB.`;
  return null;
}

// Valid photos up to PICTURE_BATCH_MAX. A bad file does not take a slot and does not drop the others.
export function splitPictureBatch(files) {
  const accepted = [];
  const errors = [];
  for (const file of files || []) {
    const name = file?.name || 'Picture';
    const error = pictureFileError(file);
    if (error) { errors.push({ name, error }); continue; }
    if (accepted.length >= PICTURE_BATCH_MAX) {
      errors.push({ name, error: `Only ${PICTURE_BATCH_MAX} pictures at a time.` });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, errors };
}

async function defaultConvertHeic(file) {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: PICTURE_JPEG_QUALITY });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], jpegName(file.name), { type: 'image/jpeg' });
}

// createImageBitmap with imageOrientation bakes EXIF into the pixels. <img> is the fallback.
export async function defaultDecode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close?.() };
    } catch { /* older browser, or a file it cannot decode */ }
  }
  if (typeof document === 'undefined') throw new Error('no document');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image decode failed'));
      i.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close() {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function defaultEncodeJpeg(decoded, { maxEdge, quality, name }) {
  if (typeof document === 'undefined') throw new Error('no document');
  const scale = Math.min(1, maxEdge / Math.max(decoded.w, decoded.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(decoded.w * scale));
  canvas.height = Math.max(1, Math.round(decoded.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(decoded.src, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('encode failed');
  return new File([blob], name, { type: 'image/jpeg' });
}

function withType(file, type) {
  if (file?.type) return file;
  return new File([file], file?.name || 'picture', { type: type || 'application/octet-stream' });
}

// Resize/compress one photo. HEIC is converted when the browser (or heic2any) can decode it.
// A file that cannot be decoded is uploaded as-is when it is already small enough.
export async function prepareLoadPicture(file, deps = {}) {
  const early = pictureFileError(file);
  if (early) return { ok: false, error: early };
  const type = resolveImageType(file);
  const convertHeic = deps.convertHeic || defaultConvertHeic;
  const decode = deps.decode || defaultDecode;
  const encodeJpeg = deps.encodeJpeg || defaultEncodeJpeg;
  let current = file;
  if (isHeic(file, type)) {
    try {
      const converted = await convertHeic(file);
      if (converted && converted.size) current = converted;
    } catch { /* try the original bytes below */ }
  }
  let decoded = null;
  try {
    decoded = await decode(current);
    if (!decoded?.w || !decoded?.h) throw new Error('empty image');
    const encoded = await encodeJpeg(decoded, {
      maxEdge: PICTURE_MAX_EDGE,
      quality: PICTURE_JPEG_QUALITY,
      name: jpegName(file.name),
    });
    if (encoded && encoded.size > 0 && encoded.size <= PICTURE_MAX_BYTES) {
      return { ok: true, file: encoded, contentType: 'image/jpeg' };
    }
  } catch { /* as-is, when the original is small enough */ } finally {
    try { decoded?.close?.(); } catch { /* ignore */ }
  }
  const fallback = [current, file].find((f) => f && f.size > 0 && f.size <= PICTURE_MAX_BYTES && isPictureFile(f));
  const contentType = normalizeStoredType(resolveImageType(fallback) || type);
  if (fallback && contentType) {
    return { ok: true, file: withType(fallback, contentType), contentType, asIs: true };
  }
  return { ok: false, error: 'Couldn\'t read this photo. Export it as JPEG and try again.' };
}

function normalizeStoredType(type) {
  if (type === 'image/jpg') return 'image/jpeg';
  return PICTURE_STORED_TYPES.has(type) ? type : '';
}

// One photo at a time. A failure is recorded and the rest still run.
export async function runPictureBatch(files, { prepare = prepareLoadPicture, upload, onProgress } = {}) {
  const split = splitPictureBatch(files);
  const errors = [...split.errors];
  const saved = [];
  const total = split.accepted.length;
  for (let i = 0; i < split.accepted.length; i += 1) {
    const file = split.accepted[i];
    onProgress?.({ index: i + 1, total, phase: 'reading', name: file.name });
    let prepared;
    try {
      prepared = await prepare(file);
    } catch {
      prepared = { ok: false, error: 'Couldn\'t read this photo. Export it as JPEG and try again.' };
    }
    if (!prepared?.ok) {
      errors.push({ name: file.name || 'Picture', error: prepared?.error || 'Couldn\'t read this photo.' });
      continue;
    }
    onProgress?.({ index: i + 1, total, phase: 'uploading', name: file.name });
    let up;
    try {
      up = await upload(prepared, file);
    } catch {
      up = { ok: false, error: 'Upload failed.' };
    }
    if (!up?.ok) errors.push({ name: file.name || 'Picture', error: up?.error || 'Upload failed.' });
    else saved.push(up.id);
  }
  onProgress?.(null);
  return { saved, errors };
}

function safeName(name) {
  return String(name || 'picture.jpg').replace(/[^a-zA-Z0-9._-]/g, '_') || 'picture.jpg';
}

// Same bucket and documents row as other load paperwork. load_id is set through the link API:
// a driver cannot write the owner's load_id under documents RLS, and that API already allows
// the uploader to link a file to an assigned load.
export async function uploadLoadPicture(supabase, { userId, loadId, file, contentType }, { fetchImpl } = {}) {
  if (!userId) return { ok: false, error: 'Please sign in again.' };
  if (!loadId) return { ok: false, error: 'This picture needs a load.' };
  const type = contentType === 'image/jpg' ? 'image/jpeg' : (contentType || file?.type || '');
  if (!file || file.size > PICTURE_MAX_BYTES) return { ok: false, error: 'This picture is too large. Maximum is 10 MB.' };
  if (!PICTURE_STORED_TYPES.has(type)) return { ok: false, error: 'Couldn\'t read this photo. Export it as JPEG and try again.' };
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(file.name)}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file, { contentType: type, upsert: false });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };
  const { data: row, error: dbErr } = await supabase.from('documents').insert({
    user_id: userId, doc_type: LOAD_PICTURE_TYPE, file_path: path, original_filename: file.name, load_id: null, truck_id: null,
  }).select('id').single();
  if (dbErr || !row?.id) {
    await supabase.storage.from('documents').remove([path]);
    return { ok: false, error: 'Saving the picture failed.' };
  }
  let linked = false;
  let linkError = 'Couldn\'t link this picture to the load. It was not saved.';
  try {
    const res = await authedFetch(supabase.auth, `/api/documents/${row.id}/load`, {
      method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loadId }),
    }, { fetchImpl });
    if (res.ok) linked = true;
    else linkError = (await res.json().catch(() => ({}))).error || linkError;
  } catch {
    linkError = 'Couldn\'t reach the server to link this picture to the load. It was not saved.';
  }
  if (!linked) {
    await deleteDocument(supabase, { id: row.id, file_path: path }, 'documents', { missingOk: true });
    return { ok: false, error: linkError };
  }
  return { ok: true, id: row.id };
}
