// Which signature field a tap should sign. Signature field → itself. Date field → the first unsigned
// signature field (its date fills on signing). Anything else → null (normal edit).
export function signTarget(fields, f) {
  const isSig = (x) => x.kind === 'signature' || x.profile_key === 'signature';
  const isDate = (x) => x.kind === 'date' || x.profile_key === 'date';
  if (isSig(f)) return String(f.id).startsWith('tmp-') ? { error: 'Save this field first, then tap it to sign.' } : { id: f.id };
  if (!isDate(f)) return null;
  const sig = fields.find((x) => isSig(x) && !x.signed && !String(x.id).startsWith('tmp-')) || fields.find((x) => isSig(x) && !String(x.id).startsWith('tmp-'));
  return sig ? { id: sig.id } : { error: 'Add a Signature field first. The date fills in when the packet is signed.' };
}
