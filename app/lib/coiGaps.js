// COI coverage-gap warnings. Pure; used by the packet COI panel and the COI request route.
export const COVERAGES = ['auto_liability', 'cargo', 'general_liability', 'physical_damage', 'other'];
export const COVERAGE_LABELS = { auto_liability: 'Auto liability', cargo: 'Cargo', general_liability: 'General liability', physical_damage: 'Physical damage', other: 'Other' };
export const REQUIRED_COVERAGES = ['auto_liability', 'cargo'];
export const DEFAULT_MINIMUMS = { auto_liability: 1000000, cargo: 100000 };

const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

export function minimumsFrom(profile) {
  const n = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  return { auto_liability: n(profile?.min_auto_liability, DEFAULT_MINIMUMS.auto_liability), cargo: n(profile?.min_cargo, DEFAULT_MINIMUMS.cargo) };
}

// → [{ code, severity: 'error'|'warn', coverage?, text }]
// Only confirmed policies satisfy coverage. Unconfirmed (AI-suggested) rows produce an 'unconfirmed' warning.
export function coiGaps({ policies = [], profile = null, loadDate = null, certHolder = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  const mins = minimumsFrom(profile);
  const confirmed = policies.filter((p) => p && p.confirmed);
  const unconfirmed = policies.filter((p) => p && !p.confirmed);
  const onDate = day(loadDate) || day(today);
  for (const cov of REQUIRED_COVERAGES) {
    const rows = confirmed.filter((p) => p.coverage === cov);
    const label = COVERAGE_LABELS[cov];
    if (!rows.length) { out.push({ code: 'missing', severity: 'error', coverage: cov, text: `${label} coverage is missing.` }); continue; }
    const best = Math.max(...rows.map((p) => (Number.isFinite(Number(p.limit_amount)) && p.limit_amount !== null ? Number(p.limit_amount) : -1)));
    if (best < 0) out.push({ code: 'limit_unknown', severity: 'warn', coverage: cov, text: `${label} limit isn’t entered.` });
    else if (best < mins[cov]) out.push({ code: 'below_min', severity: 'error', coverage: cov, text: `${label} limit ${usd(best)} is below the ${usd(mins[cov])} minimum.` });
  }
  for (const p of confirmed) {
    const exp = day(p.expiry_date), eff = day(p.effective_date), label = COVERAGE_LABELS[p.coverage] || 'Policy';
    if (exp && onDate && exp < onDate) out.push({ code: 'expired', severity: 'error', coverage: p.coverage, text: `${label} policy${p.policy_number ? ` ${p.policy_number}` : ''} expires ${exp}, before ${day(loadDate) ? 'the load date' : 'today'} (${onDate}).` });
    else if (!exp) out.push({ code: 'expiry_unknown', severity: 'warn', coverage: p.coverage, text: `${label} policy has no expiry date.` });
    if (eff && onDate && eff > onDate) out.push({ code: 'not_effective', severity: 'error', coverage: p.coverage, text: `${label} policy isn’t effective until ${eff}.` });
  }
  if (!certHolder || !String(certHolder.name || '').trim()) out.push({ code: 'cert_holder_missing', severity: 'error', text: 'Certificate holder (the broker’s name and address) is missing.' });
  else if (!String(certHolder.address || '').trim()) out.push({ code: 'cert_holder_address_missing', severity: 'warn', text: 'Certificate holder address is missing.' });
  if (unconfirmed.length) out.push({ code: 'unconfirmed', severity: 'warn', text: `${unconfirmed.length} suggested polic${unconfirmed.length === 1 ? 'y needs' : 'ies need'} your confirmation.` });
  return out;
}
