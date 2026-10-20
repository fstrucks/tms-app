// /loads banner + data source when the user is in several companies and another company is active. Pure.
import { ROLE_LABELS } from './companyRoles.js';
// ac = fetchActiveCompany() result. → null (show your own loads as before) | { kind, owner_id, text, href, linkText }
export function viewingFor(ac, uid) {
  const a = ac?.multi ? ac.active : null;
  if (!a || a.role === 'owner' || a.owner_id === uid) return null;
  const role = ROLE_LABELS[a.role] || a.role;
  if (a.role === 'driver') return { kind: 'driver', owner_id: a.owner_id, text: `You’re working in ${a.name} as ${role}. Your current load is on`, href: '/', linkText: 'Home' };
  return { kind: 'company', owner_id: a.owner_id, text: `Showing ${a.name}’s loads (you’re ${role}). Switch companies from the account menu. Edit loads in`, href: '/dispatch', linkText: 'Dispatch' };
}
