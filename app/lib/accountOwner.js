// One "is this user a company owner?" check for the whole account menu (QA #78 b).
// Before: Invite testers and Bug reports each queried company_profiles on their own when the menu opened, and an
// empty answer hid the item. An RLS read made while the session token is missing/expired/being refreshed goes out
// with the anon key and returns [] with no error, so on a page that had been open a while (the packet editor,
// whose own API calls refresh the token) both items could vanish, and Invite testers cached that false for the
// rest of the tab. Now: no session → "don't know" (keep what we had); only a confirmed "owner" is cached; a
// "not owner" is re-checked on the next open; and both items read the same answer, so they show or hide together.
const ownerCache = new Map(); // userId → true (positives only)

// → { owner: boolean, definite: boolean }. definite=false means "couldn't tell"; callers keep their last value.
export async function companyOwnerStatus(supabase, userId) {
  if (!supabase || !userId) return { owner: false, definite: false };
  if (ownerCache.get(userId) === true) return { owner: true, definite: true };
  let session = null;
  try { ({ data: { session } = {} } = await supabase.auth.getSession()); } catch { session = null; }
  if (!session?.access_token || (session.user?.id && session.user.id !== userId)) return { owner: false, definite: false };
  let res;
  try { res = await supabase.from('company_profiles').select('id').eq('owner_id', userId).limit(1); } catch { return { owner: false, definite: false }; }
  const { data, error } = res || {};
  if (error || !Array.isArray(data)) return { owner: false, definite: false };
  const owner = data.length > 0;
  if (owner) ownerCache.set(userId, true);
  return { owner, definite: true };
}
export const cachedOwner = (userId) => ownerCache.get(userId) === true;
export const clearOwnerCache = () => ownerCache.clear();

// The account menu, top to bottom, on every page (one AccountMenu, rendered by AppNav from app/layout.js).
export const ACCOUNT_MENU_ORDER = ['Password', 'Company profile', 'Invite testers', 'Bug reports', 'Carrier packets', 'Welcome tour', 'Sign out'];
export const OWNER_ONLY_ITEMS = ['Invite testers', 'Bug reports'];
export function accountMenuItems({ owner = false } = {}) {
  return ACCOUNT_MENU_ORDER.filter((k) => owner || !OWNER_ONLY_ITEMS.includes(k));
}
