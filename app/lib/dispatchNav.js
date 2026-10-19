// Nav tabs for the signed-in user. Management / dispatchers get "Dispatch" (/dispatch) in the Loads slot.
export const DISPATCH_TAB = { href: '/dispatch', label: 'Dispatch', icon: '🗂️', match: (p) => p.startsWith('/dispatch') || p.startsWith('/loads') };
export function navTabs(tabs, { dispatcher = false } = {}) {
  return dispatcher ? tabs.map((t) => (t.href === '/loads' ? DISPATCH_TAB : t)) : tabs;
}
