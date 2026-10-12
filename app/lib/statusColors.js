// Load status tag colors (pick 5A): exact PR #33 section 3 light colors, one hue per status. Light: tint background + dark text.
// Dark set (used only under [data-theme="dark"], for a future app-wide dark mode): deep background + light text. Paid is a solid filled tag.
// Every pair is >= 4.5:1 (tests/js/statusColors.test.mjs). Color is never the only signal: the label is always shown.
const BLUE = { light: ['#dbeafe', '#1e40af'], dark: ['#1e3a8a', '#dbeafe'] };
const INDIGO = { light: ['#e0e7ff', '#3730a3'], dark: ['#312e81', '#e0e7ff'] };
const AMBER = { light: ['#fef3c7', '#92400e'], dark: ['#78350f', '#fef3c7'] };
const GREEN = { light: ['#dcfce7', '#166534'], dark: ['#14532d', '#dcfce7'] };
const TEAL = { light: ['#ccfbf1', '#115e59'], dark: ['#134e4a', '#ccfbf1'] };
const PAID = { light: ['#15803d', '#ffffff'], dark: ['#4ade80', '#052e16'] };
const GRAY = { light: ['#f3f4f6', '#4b5563'], dark: ['#374151', '#e5e7eb'] };
export const UNKNOWN = { light: ['#f3f4f6', '#374151'], dark: ['#374151', '#f3f4f6'], dashed: true };

export const STATUS_COLORS = {
  booked: BLUE, dispatched: INDIGO, in_transit: AMBER, delivered: GREEN, invoiced: TEAL,
  paid: PAID, cancelled: GRAY, canceled: GRAY, tonu: GRAY, void: GRAY,
};
const LABELS = { in_transit: 'In transit', tonu: 'TONU', canceled: 'Cancelled' };

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
export function statusColors(status) { return STATUS_COLORS[norm(status)] || UNKNOWN; }
export function statusLabel(status) {
  const k = norm(status);
  if (!k) return 'Unknown';
  if (LABELS[k]) return LABELS[k];
  const t = k.replaceAll('_', ' ');
  return t[0].toUpperCase() + t.slice(1);
}

// WCAG 2.x contrast ratio between two #rrggbb colors.
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
