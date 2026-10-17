// Field names the packet editor can pick, beyond the company-profile keys the reader uses.
// Stored in packet_fields.profile_key (free text, no CHECK constraint), so none of this needs SQL:
//   - extra keys (contact_name, truck_number, …): hand-filled for now; later they map to a Driver Profile
//   - 'skip': "Leave blank / skip" (counts as named, never filled)
//   - 'custom:<name>': "Custom (type a name)"; the name is typed by the user, hand-filled
import { PROFILE_KEYS } from './packetReader.js';

export const EXTRA_KEY_LABELS = {
  contact_name: 'Contact name', contact_phone: 'Contact phone', contact_email: 'Contact email',
  driver_name: 'Driver name', truck_number: 'Truck number', trailer_number: 'Trailer number',
  truck_plate: 'Truck plate', truck_plate_state: 'Truck plate state', trailer_plate: 'Trailer plate', trailer_plate_state: 'Trailer plate state',
};
export const EXTRA_KEYS = Object.keys(EXTRA_KEY_LABELS);
export const SKIP_KEY = 'skip';
export const SKIP_LABEL = 'Leave blank / skip';
export const CUSTOM_PREFIX = 'custom:';
export const CUSTOM_OPTION = '__custom'; // <select> value only; never stored
export const CUSTOM_LABEL = 'Custom (type a name)';
export const CUSTOM_MAX = 60;

export const isCustomKey = (k) => typeof k === 'string' && k.startsWith(CUSTOM_PREFIX);
export const cleanCustomName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CUSTOM_MAX).trim();
// Form labels usually end in a colon ("Contact name:"); strip trailing colons (incl. full-width) and whitespace.
export const labelToName = (s) => cleanCustomName(String(s ?? '').replace(/[\s:：]+$/u, ''));
export const customName = (k) => (isCustomKey(k) ? cleanCustomName(k.slice(CUSTOM_PREFIX.length)) : '');
// Keeps the typed text (even empty) so the input doesn't jump while typing; an empty name still counts as unnamed.
export const customKey = (name) => CUSTOM_PREFIX + String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, CUSTOM_MAX);
export const isSkipKey = (k) => k === SKIP_KEY;
// Unnamed = no key, or a custom key whose name is still blank.
export const isUnnamedKey = (k) => !k || (isCustomKey(k) && !customName(k));

const BASE_KEYS = PROFILE_KEYS.filter((k) => k !== 'unknown');
// Server-side validation of a stored name. Returns { key } (normalized) or { error }.
export function validateNameKey(key, kind) {
  if (!key) return { key: null };
  if (isCustomKey(key)) {
    const n = cleanCustomName(key.slice(CUSTOM_PREFIX.length));
    return n ? { key: CUSTOM_PREFIX + n } : { error: 'Type a name for the custom field.' };
  }
  if (key === SKIP_KEY) return kind === 'signature' ? { error: 'A signature box can’t be skipped. Remove the field instead.' } : { key };
  if (BASE_KEYS.includes(key) || EXTRA_KEYS.includes(key)) return { key };
  return { error: 'Unknown field name' };
}
// <select> option groups for the editor's Name picker.
export function nameOptions(KEY_LABELS, kind) {
  return [
    { group: 'Company profile', options: BASE_KEYS.map((k) => ({ value: k, label: KEY_LABELS[k] })) },
    { group: 'Contact, driver & equipment (you type the value)', options: EXTRA_KEYS.map((k) => ({ value: k, label: EXTRA_KEY_LABELS[k] })) },
    { group: 'Other', options: [{ value: CUSTOM_OPTION, label: CUSTOM_LABEL }, ...(kind === 'signature' ? [] : [{ value: SKIP_KEY, label: SKIP_LABEL }])] },
  ];
}
// Flat <select> rows with visible, disabled heading rows. <optgroup> labels didn't show in Taylor's run, and iOS Safari's
// picker shows disabled rows as grey text, so headings render the same in every browser.
export const HEADING_PREFIX = '__h:';
export const isHeadingValue = (v) => typeof v === 'string' && v.startsWith(HEADING_PREFIX);
export function nameSelectRows(KEY_LABELS, kind) {
  return nameOptions(KEY_LABELS, kind).flatMap((g, i) => [
    { value: HEADING_PREFIX + i, label: `— ${g.group} —`, heading: true, disabled: true },
    ...g.options.map((o) => ({ ...o, group: g.group })),
  ]);
}
// Which group the current name belongs to (shown under the picker as a visible heading).
export function nameGroup(KEY_LABELS, kind, key) {
  const v = selectValue(key);
  if (!v) return '';
  return nameSelectRows(KEY_LABELS, kind).find((r) => !r.heading && r.value === v)?.group || '';
}
export const selectValue = (k) => (isCustomKey(k) ? CUSTOM_OPTION : k || '');
// Picking an option → the profile_key to store. Custom starts from the form's own label (e.g. "Contact name").
export function keyFromSelect(value, f = {}) {
  if (value === CUSTOM_OPTION) return isCustomKey(f.profile_key) ? f.profile_key : customKey(labelToName(f.label));
  if (isHeadingValue(value)) return f.profile_key ?? null; // headings are disabled; never change the name
  return value || null;
}
