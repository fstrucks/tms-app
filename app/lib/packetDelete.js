// Packet delete (server only, service key). Collects every storage object the packet owns, deletes the row
// (packet_fields and packet_sends cascade), then removes the files. inbound_emails rows are kept (audit log;
// their packet link is set to null by the FK).
const BUCKET = 'documents';
const isPacketPath = (p) => typeof p === 'string' && p.length > 0 && p.includes('/packets/') && !p.includes('..');

export async function packetStoragePaths(sb, packet) {
  const id = packet.id, owner = packet.owner_id;
  const paths = new Set([packet.file_path, packet.filled_path].filter(isPacketPath));
  const store = sb.storage.from(BUCKET);
  const [fields, sends, filled, sigs] = await Promise.all([
    sb.from('packet_fields').select('signature_path').eq('packet_id', id),
    sb.from('packet_sends').select('filled_path').eq('packet_id', id), // table may be missing before 20261016001700
    store.list(`${owner}/packets/filled`, { search: `${id}-`, limit: 1000 }), // every Fill & download makes a new file
    store.list(`${owner}/packets/signatures/${id}`, { limit: 1000 }),
  ]);
  for (const f of fields.data || []) if (isPacketPath(f.signature_path)) paths.add(f.signature_path);
  for (const s of sends.data || []) if (isPacketPath(s.filled_path)) paths.add(s.filled_path);
  for (const o of filled.data || []) if (o?.name?.startsWith(`${id}-`)) paths.add(`${owner}/packets/filled/${o.name}`);
  for (const o of sigs.data || []) if (o?.name && o.id !== null) paths.add(`${owner}/packets/signatures/${id}/${o.name}`);
  return [...paths];
}

// → { ok, removed, storageWarning? } | { error, status }
export async function deletePacket(sb, packet) {
  let paths;
  try { paths = await packetStoragePaths(sb, packet); } catch (e) { console.error('[packets] delete list', e?.message); paths = [packet.file_path, packet.filled_path].filter(isPacketPath); }
  const { error } = await sb.from('packets').delete().eq('id', packet.id);
  if (error) { console.error('[packets] delete row', error.code); return { error: 'Could not delete the packet. Please try again.', status: 500 }; }
  if (!paths.length) return { ok: true, removed: 0 };
  const store = sb.storage.from(BUCKET);
  let r = await store.remove(paths);
  if (r?.error) r = await store.remove(paths); // one retry
  if (r?.error) {
    console.error('[packets] delete storage (orphaned files)', packet.id, paths.length, r.error.message);
    return { ok: true, removed: 0, storageWarning: 'The packet was deleted, but some of its files could not be removed from storage.' };
  }
  return { ok: true, removed: paths.length };
}
