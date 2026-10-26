// Insert WITHOUT RETURNING, then re-read. The select policy uses company_role(), a STABLE function whose
// snapshot predates the insert, so INSERT ... RETURNING (insert().select()) fails RLS with 42501 on the
// first save even though the insert itself is allowed.
// Columns added after the first release. If the database doesn't have one yet (migration not applied), the save is
// retried without it, so the rest of the profile still saves exactly as before.
export const OPTIONAL_COLUMNS = ['owner_name', 'reply_to_email'];
const MISSING_COL = new Set(['42703', 'PGRST204']);
export const missingColumn = (error, col) => !!error && MISSING_COL.has(error.code) && String(error.message || '').includes(col);
export async function saveProfileGraceful(c, row) {
  let r = await saveProfile(c, row);
  const dropped = [];
  for (const col of OPTIONAL_COLUMNS) {
    if (!r.error || !(col in row) || !missingColumn(r.error, col)) continue;
    const { [col]: _omit, ...rest } = row; row = rest; dropped.push(col);
    r = await saveProfile(c, row);
  }
  return { ...r, dropped };
}
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
