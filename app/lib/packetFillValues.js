// Server: packet_fields rows (+ owner's company profile) → values for fillPacket. Decrypts bank/EIN here only.
// Precedence: the field's own value, then the company profile, then (date fields) the signing/fill date.
import { formatPacketDate } from './packetSign.js';
const PROFILE_TEXT = new Set(['legal_name', 'dba_name', 'mc_number', 'dot_number', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'phone', 'email', 'signer_name', 'signer_title']);

export function resolveFillValues(rows, profile, { decrypt, images = {}, today = new Date() }) {
  const out = [], missing = [];
  const signedAt = rows.map((r) => r.signed_at).filter(Boolean).sort().pop();
  for (const r of rows) {
    const f = { id: r.id, page: r.page, kind: r.kind, box: r.box, needs_confirm: !!r.needs_confirm, confirmed: !!r.confirmed_at };
    const key = r.profile_key;
    if (r.kind === 'signature' || key === 'signature') {
      f.kind = 'signature'; f.image = r.signature_path ? images[r.signature_path] || null : null;
      if (!f.image) missing.push({ id: r.id, page: r.page, what: 'signature' });
    } else if (r.kind === 'date' || key === 'date') {
      f.kind = 'text'; f.value = r.value_text || formatPacketDate(signedAt || today);
    } else if (r.value_ciphertext) {
      f.value = decrypt(r.value_ciphertext);
    } else if (r.value_text) {
      f.value = r.value_text;
    } else if (key === 'ein' && profile?.ein_ciphertext) {
      const d = String(decrypt(profile.ein_ciphertext) || ''); f.value = d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : d;
    } else if (PROFILE_TEXT.has(key) && profile?.[key]) {
      f.value = profile[key];
    }
    out.push(f);
  }
  return { fields: out, missing };
}
