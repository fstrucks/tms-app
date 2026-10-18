'use client';
// Owner-only "Invite testers" item for the account menu. Who is an owner is decided once by AccountMenu
// (lib/accountOwner) and passed in, so this and Bug reports always show or hide together. The server re-checks.
import Link from 'next/link';
import { companyOwnerStatus } from '../../lib/accountOwner';

// Kept for callers/tests: true only when the check could tell and the user owns a company.
export async function isCompanyOwner(supabase, userId) {
  return (await companyOwnerStatus(supabase, userId)).owner;
}

export default function InviteTestersMenuItem({ owner, onClick, style }) {
  if (!owner) return null;
  return <Link href="/account/invite" role="menuitem" onClick={onClick} style={style} data-testid="menu-invite-testers">Invite testers</Link>;
}
