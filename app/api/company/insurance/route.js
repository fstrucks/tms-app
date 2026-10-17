import { insuranceCtx, canWriteInsurance, json, isMissing } from '../../../lib/insuranceServer';
import { validateAgent, COI_MIGRATION } from '../../../lib/coiRequest';
import { minimumsFrom } from '../../../lib/coiGaps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const SETUP = { error: 'Insurance info needs a database update that hasn’t been applied yet.', setupNeeded: true, migration: COI_MIGRATION };

export async function load(c) {
  const [a, p] = await Promise.all([
    c.sb.from('insurance_agents').select('*').eq('owner_id', c.ownerId).maybeSingle(),
    c.sb.from('insurance_policies').select('*').eq('owner_id', c.ownerId).order('coverage'),
  ]);
  if (a.error || p.error) return { error: a.error || p.error };
  return { agent: a.data || null, policies: p.data || [] };
}

// Agent + policies + minimums. Any member may view; owner/management may edit.
export async function GET(req, { deps } = {}) {
  const c = await insuranceCtx(req, deps); if (c.res) return c.res;
  const d = await load(c);
  if (d.error) return isMissing(d.error) ? json({ ...SETUP, canEdit: canWriteInsurance(c.role) }) : json({ error: 'Could not load insurance info.' }, 500);
  return json({ ...d, minimums: minimumsFrom(c.profile), role: c.role, canEdit: canWriteInsurance(c.role) });
}

// Body: { agent?: { name, agency, email, phone }, minimums?: { auto_liability, cargo } }
export async function PUT(req, { deps } = {}) {
  const c = await insuranceCtx(req, deps); if (c.res) return c.res;
  if (!canWriteInsurance(c.role)) return json({ error: 'Only the owner or management can edit insurance info.' }, 403);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (b.agent) {
    const { agent, errors } = validateAgent(b.agent);
    if (Object.keys(errors).length) return json({ error: 'Please fix the highlighted fields.', errors }, 422);
    const r = await c.sb.from('insurance_agents').upsert({ owner_id: c.ownerId, ...agent, updated_by: c.user.id, updated_at: new Date().toISOString() }, { onConflict: 'owner_id' });
    if (r.error) return isMissing(r.error) ? json(SETUP, 503) : json({ error: 'Could not save the agent.' }, 500);
  }
  if (b.minimums) {
    const n = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));
    const auto = n(b.minimums.auto_liability), cargo = n(b.minimums.cargo);
    if ([auto, cargo].some((x) => x === null || !Number.isFinite(x) || x < 0)) return json({ error: 'Minimums must be dollar amounts.', errors: { minimums: 'Enter dollar amounts.' } }, 422);
    if (!c.profile) return json({ error: 'Save the company profile first.' }, 409);
    const r = await c.sb.from('company_profiles').update({ min_auto_liability: auto, min_cargo: cargo }).eq('id', c.profile.id);
    if (r.error) return isMissing(r.error) ? json(SETUP, 503) : json({ error: 'Could not save the minimums.' }, 500);
    c.profile = { ...c.profile, min_auto_liability: auto, min_cargo: cargo };
  }
  const d = await load(c);
  if (d.error) return json({ error: 'Saved, but could not reload insurance info.' }, 500);
  return json({ ...d, minimums: minimumsFrom(c.profile), role: c.role, canEdit: true });
}
