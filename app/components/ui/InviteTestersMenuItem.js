'use client';
// Owner-only "Invite testers" item for the account menu. Owner = the signed-in user owns a company_profiles row
// (a light RLS-scoped read; cached per user so reopening the menu doesn't re-query). The server re-checks.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../../lib/supabase';

const cache = new Map(); // userId → boolean
export async function isCompanyOwner(supabase, userId) {
  if (!supabase || !userId) return false;
  if (cache.has(userId)) return cache.get(userId);
  const { data, error } = await supabase.from('company_profiles').select('id').eq('owner_id', userId).limit(1);
  const owner = !error && Array.isArray(data) && data.length > 0;
  if (!error) cache.set(userId, owner);
  return owner;
}

export default function InviteTestersMenuItem({ userId, onClick, style }) {
  const [owner, setOwner] = useState(cache.get(userId) || false);
  useEffect(() => { let on = true; isCompanyOwner(getSupabase(), userId).then((v) => on && setOwner(v)).catch(() => {}); return () => { on = false; }; }, [userId]);
  if (!owner) return null;
  return <Link href="/account/invite" role="menuitem" onClick={onClick} style={style}>Invite testers</Link>;
}
