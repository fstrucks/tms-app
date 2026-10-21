// Account menu → "Invoices" entry (Taylor's QA nit, PR 3). Right after sign-in the active company's role isn't known for
// a moment. So the menu doesn't jump, and drivers never see the entry:
//   role known       → office role ? 'show' : 'hide' (and remembered for this user on this device)
//   role not known   → remembered 'show' / 'hide' if we've seen this user before, else 'reserve' (an empty slot of
//                      the same height, not a link, so nothing a driver could tap)
import { canViewInvoices } from './invoice.js';

const KEY = (uid) => `ph.invoicesMenu.${uid}`;
export function invoiceMenuState(role, remembered) {
  if (role) return canViewInvoices(role) ? 'show' : 'hide';
  if (remembered === '1') return 'show';
  if (remembered === '0') return 'hide';
  return 'reserve';
}
export function rememberedInvoiceMenu(uid, storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try { return uid && storage ? storage.getItem(KEY(uid)) : null; } catch { return null; }
}
export function rememberInvoiceMenu(uid, role, storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try { if (uid && role && storage) storage.setItem(KEY(uid), canViewInvoices(role) ? '1' : '0'); } catch { /* private mode */ }
}
