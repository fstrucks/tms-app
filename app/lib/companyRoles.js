// Mirrors public.company_can_edit / company_can_sign in 20261015001200_company_profiles.sql.
export const ROLES = ['owner', 'dispatcher', 'management', 'driver'];
export const ROLE_LABELS = { owner: 'Owner', dispatcher: 'Dispatcher', management: 'Management', driver: 'Driver' };
const EDITORS = new Set(['owner', 'dispatcher', 'management']);
export const isRole = (r) => ROLES.includes(r);
export const canEdit = (r) => EDITORS.has(r);
export const canSign = (r) => EDITORS.has(r);
export const canView = (r) => isRole(r);
export const canUpload = (r) => isRole(r);

// Role for a user given a profile row and that user's member rows. Owner of the row always wins.
export function roleFor(userId, profile, members = []) {
  if (!userId || !profile) return null;
  if (profile.owner_id === userId) return 'owner';
  const m = members.find((x) => x.profile_id === profile.id && x.user_id === userId);
  return m && isRole(m.role) ? m.role : null;
}
