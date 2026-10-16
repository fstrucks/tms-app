// Client: manual packet upload. Same private bucket as documents, path {uploader_id}/packets/... (storage policies are uploader-path)
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export function validatePacketFile(file) {
  if (!file) return 'Choose a PDF first.';
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''))) return 'Packets must be PDF files.';
  if (file.size > UPLOAD_MAX_BYTES) return 'The PDF is larger than 10 MB.';
  return null;
}
export async function uploadPacket(supabase, { userId, ownerId, file, onCreated }) {
  const err = validatePacketFile(file); if (err) return err;
  if (!userId || !ownerId) return 'Please sign in again.';
  const path = `${userId}/packets/${Date.now()}-0-${String(file.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file, { contentType: 'application/pdf' });
  if (upErr) return 'Upload failed: ' + upErr.message;
  const ins = supabase.from('packets').insert({ owner_id: ownerId, source: 'upload', uploaded_by: userId, file_path: path, original_filename: file.name, size_bytes: file.size, status: 'received' });
  const { data, error } = onCreated && ins.select ? await ins.select('id').single() : await ins;
  if (error) { await supabase.storage.from('documents').remove([path]); return 'Saving packet failed: ' + error.message; }
  if (onCreated && data?.id) onCreated(data.id); // caller starts detection (POST /api/packets/{id}/process)
  return null;
}
