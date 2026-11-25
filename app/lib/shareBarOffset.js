// Height the phone's Sharing location bar takes above the bottom tab bar, published as --share-bar-h on <html>
// so the Report a bug button and bottom-anchored controls sit above it (they add var(--share-bar-h, 0px)).
// Only while the bar is fixed at the bottom (phones). On desktop it is sticky under the top nav: 0.
export const SHARE_BAR_VAR = '--share-bar-h';
export function shareBarOffsetPx(position, height) {
  const h = Number(height);
  return position === 'fixed' && Number.isFinite(h) && h > 0 ? Math.ceil(h) : 0;
}
// Writes the variable (or clears it at 0) on a style declaration, e.g. document.documentElement.style.
export function applyShareBarOffset(style, px) {
  if (!style) return;
  if (px > 0) style.setProperty(SHARE_BAR_VAR, `${px}px`); else style.removeProperty(SHARE_BAR_VAR);
}
