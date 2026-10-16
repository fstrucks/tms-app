// Why "Fill & download" can't run yet (shown up front instead of erroring on click). [] = ready.
import { unconfirmedBank } from './packetMapperModel.js';
export const isSigField = (f) => f.kind === 'signature' || f.profile_key === 'signature';
export function fillBlockers(fields, { dirty = false } = {}) {
  const out = [];
  if (!fields.length) out.push({ code: 'no_fields', text: 'Add fields first.' });
  if (dirty) out.push({ code: 'unsaved', text: 'Save your changes first.' });
  const bank = unconfirmedBank(fields);
  if (bank.length) out.push({ code: 'bank', text: bank.length === 1 ? 'Confirm the bank number.' : `Confirm ${bank.length} bank numbers.`, field: bank[0] });
  const unsigned = fields.filter((f) => isSigField(f) && !f.signed);
  if (unsigned.length) out.push({ code: 'unsigned', text: unsigned.length === 1 ? 'Sign the signature field.' : `Sign ${unsigned.length} signature fields.`, field: unsigned[0] });
  return out;
}
