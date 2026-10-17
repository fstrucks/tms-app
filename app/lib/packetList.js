// Server side of GET /api/packets: the /packets list in two parallel database rounds instead of the old
// client waterfall (session → company profile → packets, each a separate phone↔Supabase round trip).
//   Round 1 (caller's token, RLS decides what they may see): packets + company owner + archived count.
//   Round 2 (service key, only for the packet ids RLS returned): field counts, signature fields, caller's role.
// No signed URLs or file reads here; the PDF is only fetched when a packet is opened.
import { canEdit as canEditRole, isRole } from './companyRoles.js';
import { packetDisplayStatus, addFieldHint, canManagePackets } from './packetStatus.js';

export const LIST_COLS = 'id,owner_id,source,status,subject,original_filename,created_at,manual_reason,filled_at,sent_at';
export const LIST_LIMIT = 100;
const isJwtError = (r) => r?.status === 401 || /^PGRST30/.test(r?.error?.code || '') || /jwt/i.test(r?.error?.message || '');

export async function listPackets({ uc, sb, view = 'active', timings = {} }) {
  const t0 = Date.now();
  let q = uc.from('packets').select(LIST_COLS).order('created_at', { ascending: false }).limit(LIST_LIMIT);
  q = view === 'archived' ? q.eq('status', 'archived') : q.neq('status', 'archived');
  const [pk, prof, arch] = await Promise.all([
    q,
    uc.from('company_profiles').select('owner_id').limit(1),
    view === 'archived' ? null : uc.from('packets').select('id', { count: 'exact', head: true }).eq('status', 'archived'),
  ]);
  timings.db1 = Date.now() - t0;
  if (isJwtError(pk)) return { status: 401, error: 'Sign in again.' };
  if (pk.error) { console.error('[packets] list', pk.error.code); return { status: 500, error: 'Could not load packets.' }; }
  const rows = pk.data || [];
  const ids = rows.map((r) => r.id);
  const owners = [...new Set(rows.map((r) => r.owner_id))];

  const t1 = Date.now();
  const [counts, sigs, ...roles] = await Promise.all([
    ids.length ? sb.from('packets').select('id,packet_fields(count)').in('id', ids) : { data: [] },
    ids.length ? sb.from('packet_fields').select('packet_id,signature_path').in('packet_id', ids).or('kind.eq.signature,profile_key.eq.signature') : { data: [] },
    ...owners.map((o) => uc.rpc('packet_role', { p_owner: o })),
  ]);
  timings.db2 = Date.now() - t1;
  const fieldsOk = !counts.error && !sigs.error;
  if (!fieldsOk) console.error('[packets] list summary', counts.error?.code, sigs.error?.code); // degrade: status from the packet row only
  const sum = new Map(ids.map((id) => [id, { fieldCount: 0, sigTotal: 0, sigSigned: 0 }]));
  for (const c of counts.data || []) { const s = sum.get(c.id); if (s) s.fieldCount = Number(c.packet_fields?.[0]?.count || 0); }
  for (const f of sigs.data || []) { const s = sum.get(f.packet_id); if (s) { s.sigTotal++; if (f.signature_path) s.sigSigned++; } }
  const roleOf = new Map(owners.map((o, i) => [o, isRole(roles[i]?.data) ? roles[i].data : null]));

  const out = rows.map((r) => {
    const role = roleOf.get(r.owner_id);
    const s = fieldsOk ? sum.get(r.id) : null;
    const d = packetDisplayStatus(r, s);
    return {
      id: r.id, source: r.source, status: r.status, subject: r.subject, original_filename: r.original_filename, created_at: r.created_at,
      filled_at: r.filled_at ?? null, sent_at: r.sent_at ?? null, display: d.key, label: d.label, color: d.color,
      ...(s || {}), hint: addFieldHint(r, s, canEditRole(role)), canManage: canManagePackets(role),
    };
  });
  return { rows: out, ownerId: prof?.data?.[0]?.owner_id || null, archivedCount: arch ? (arch.count ?? 0) : out.length, canManage: out.some((r) => r.canManage) };
}
