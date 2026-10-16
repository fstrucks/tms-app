// Insert WITHOUT RETURNING, then re-read. The select policy uses company_role(), a STABLE function whose
// snapshot predates the insert, so INSERT ... RETURNING (insert().select()) fails RLS with 42501 on the
// first save even though the insert itself is allowed.
export async function saveProfile(c, row) {
  if (c.profile) return c.sb.from('company_profiles').update(row).eq('id', c.profile.id).select('*').single();
  const ins = await c.sb.from('company_profiles').insert({ ...row, owner_id: c.user.id });
  if (ins.error) return ins;
  return c.sb.from('company_profiles').select('*').eq('owner_id', c.user.id).single();
}

export function saveErrorMessage(error) {
  switch (error?.code) {
    case '42501': return 'Could not save the company profile: permission denied by database policy.';
    case '23505': return 'A company profile already exists for this account. Reload the page.';
    case '42703': case 'PGRST204': return 'Could not save the company profile: the database is missing a column (migration not applied).';
    case '42P01': case 'PGRST205': return 'Could not save the company profile: the company tables are missing (migration not applied).';
    case '23514': return 'Could not save the company profile: a value failed a database check.';
    default: return 'Could not save the company profile.';
  }
}
