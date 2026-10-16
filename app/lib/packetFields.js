// D orchestration: local detection → model naming (if key) → packet_fields rows. Pure except the injected reader.
import { detectPacket } from './packetDetect.js';
import { LOW_CONFIDENCE } from './packetValues.js';

export async function buildPacketFields({ packetId, ownerId, pages, reader, dpi = 200 }) {
  const detected = detectPacket(pages);
  let named = { skipped: true, fields: detected.map((f) => ({ ...f, profile_key: null, confidence: 0, needs_confirm: false })) };
  let error = null;
  if (reader?.enabled && detected.length) {
    try { named = await reader.nameFields(detected); } catch (e) { error = e.message; } // fall back to manual mapping
  }
  const rows = named.fields.map((f) => ({
    packet_id: packetId, owner_id: ownerId, field_key: f.id, page: f.page, kind: f.kind, label: f.label || null, box: f.box, dpi,
    profile_key: f.profile_key, confidence: f.confidence, source: named.skipped ? 'local' : 'model', needs_confirm: !!f.needs_confirm,
  }));
  const low = rows.filter((r) => !r.profile_key || r.confidence < LOW_CONFIDENCE).length;
  return { rows, summary: { detected: detected.length, named: !named.skipped, low_confidence: low, error } };
}
