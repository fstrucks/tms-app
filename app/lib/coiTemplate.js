// COI request email template + "auto body until hand-edited" logic. Pure and client-safe (no Node APIs).
import { COVERAGE_LABELS, minimumsFrom } from './coiGaps.js';

const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const clip = (s, n) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

export function defaultCoiDraft({ packet, profile, agent, certHolder, loadDate } = {}) {
  const co = String(profile?.legal_name || '').trim() || 'our company';
  const mins = minimumsFrom(profile);
  const who = String(agent?.name || '').trim().split(/\s+/)[0] || 'there';
  const ref = String(packet?.subject || packet?.original_filename || '').replace(/\.pdf$/i, '').replace(/^(re|fwd?):\s*/i, '').trim();
  const holder = [certHolder?.name, certHolder?.address].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
  return {
    subject: `COI request – ${co}${certHolder?.name ? ` – holder: ${clip(certHolder.name, 80)}` : ''}`.slice(0, 200),
    body: [
      `Hi ${who},`, '',
      `Please send a certificate of insurance for ${co}${profile?.mc_number ? ` (MC ${profile.mc_number})` : ''}${ref ? ` for ${ref}` : ''}.`, '',
      'Certificate holder:', holder || '[broker name and address]', '',
      `Coverage needed: ${COVERAGE_LABELS.auto_liability} ${usd(mins.auto_liability)}, ${COVERAGE_LABELS.cargo} ${usd(mins.cargo)}.`,
      ...(loadDate ? [`Coverage must be in force on ${String(loadDate).slice(0, 10)}.`] : []), '',
      'Please reply to this email with the certificate attached.', '', 'Thank you,', co,
    ].join('\n'),
  };
}

// Body follows the template (holder name/address, load date) until the user types in the body.
// State: { body, bodyDirty }. Template edits only replace the body while bodyDirty is false.
export function syncBody(state, template) { return state.bodyDirty ? state : { ...state, body: template.body }; }
export function editBody(state, text, template) { return { ...state, body: text, bodyDirty: text !== template.body }; }
export function resetBody(state, template) { return { ...state, body: template.body, bodyDirty: false }; }
