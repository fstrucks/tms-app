// Bottom space reserved under packet content for the fixed Fill & download / Save bar.
// Only reserve it while the bar is rendered; when it's hidden (Send to broker write/review) collapse it,
// otherwise iPhone shows ~100px of empty white above the bottom nav.
export const BAR_MIN_RESERVE = 110;
export const COLLAPSED_RESERVE = 16;
export function actionBarShown({ canEdit, hideActionBar, dirty }) { return !!canEdit && !(hideActionBar && !dirty); }
export function bottomReservePx(barShown, barH = 0) { return barShown ? Math.max(BAR_MIN_RESERVE, barH + 16) : COLLAPSED_RESERVE; }
export function bottomPadding(px) { return `calc(${px}px + var(--nav-h, 0px) + env(safe-area-inset-bottom))`; }
