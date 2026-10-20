// Load paperwork (BOL, POD, lumper receipt, scale ticket): which types belong under a load, who can see them,
// and which load a new scan most likely belongs to. Pure and JSX-free so Node tests can import it.

// Types that are shown under a load and get a "Link to load" picker on the Documents tab.
export const LOAD_DOC_TYPE_IDS = ['bol', 'pod', 'lumper_receipt', 'scale_ticket'];
export const isLoadDocType = (t) => LOAD_DOC_TYPE_IDS.includes(t) || String(t || '').startsWith('other:');

// Who may see a load's documents (load page Documents section):
//   owner / management / dispatcher: any load of their company (same people who already open every load);
//   driver (role driver, or an also-driver): only loads assigned to them.
// Rate confirmations show the rate, so a driver sees them only when the owner turned on "Show rate to driver".
export function canViewLoadDocs(role, load, userId) {
  if (!role || !load) return false;
  if (role === 'owner' || role === 'management' || role === 'dispatcher') return true;
  return !!userId && load.assigned_driver_user_id === userId;
}
export function visibleDocsFor(role, load, userId, docs) {
  if (!canViewLoadDocs(role, load, userId)) return [];
  const driverOnly = !(role === 'owner' || role === 'management' || role === 'dispatcher');
  return (docs || []).filter((d) => !(driverOnly && d.doc_type === 'rate_confirmation' && !load.show_rate_to_driver));
}

// Who may link a document to (or unlink it from) a load:
//   owner / management / dispatcher: any document of the company, to any company load;
//   driver: only documents they uploaded, and only to a load assigned to them.
export function canLinkDoc(role, { doc, load, userId }) {
  if (!role || !doc) return false;
  if (role === 'owner' || role === 'management' || role === 'dispatcher') return true;
  if (doc.user_id !== userId) return false;
  return !load || load.assigned_driver_user_id === userId;
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dayMs = 864e5;
const ACTIVE = ['in_transit', 'dispatched'];

// loads: [{ id, broker_load_number, reference_numbers?, status, assigned_driver_user_id, pickup_date?, delivery_date?, created_at }]
// refs: numbers read off the document (load #, PO, BOL #, pro #...). date: YYYY-MM-DD printed on it.
// → { loadId, reason: 'number' | 'driver_active' | 'date' } or null. Number match always wins.
export function suggestLoad(loads, { refs = [], date = null, userId = null } = {}) {
  const list = (loads || []).filter((l) => l?.id);
  if (!list.length) return null;
  const want = new Set((refs || []).map(norm).filter((r) => r.length >= 3));
  if (want.size) {
    const hit = list.find((l) => [l.broker_load_number, ...(Array.isArray(l.reference_numbers) ? l.reference_numbers : [])].some((n) => want.has(norm(n))));
    if (hit) return { loadId: hit.id, reason: 'number' };
  }
  const mine = userId ? list.filter((l) => l.assigned_driver_user_id === userId && ACTIVE.includes(l.status)) : [];
  if (mine.length) {
    const pick = mine.find((l) => l.status === 'in_transit') || mine[0];
    return { loadId: pick.id, reason: 'driver_active' };
  }
  const t = date ? Date.parse(`${date}T12:00:00Z`) : NaN;
  if (!Number.isNaN(t)) {
    const near = list.map((l) => {
      const a = Date.parse(`${l.pickup_date || ''}T00:00:00Z`), b = Date.parse(`${l.delivery_date || l.pickup_date || ''}T23:59:59Z`);
      if (Number.isNaN(a)) return null;
      const dist = t < a ? a - t : t > b ? t - b : 0;
      return dist <= dayMs ? { l, dist } : null;
    }).filter(Boolean).sort((x, y) => x.dist - y.dist);
    if (near.length === 1 || (near.length > 1 && near[0].dist < near[1].dist)) return { loadId: near[0].l.id, reason: 'date' };
  }
  return null;
}

export const SUGGEST_REASON = { number: 'matches the load number on the document', driver_active: 'your active load', date: 'matches the date on the document' };

// Picker label for a load.
export function loadPickLabel(l) {
  const head = l.broker_load_number ? `#${l.broker_load_number}` : 'Load';
  const when = l.pickup_date ? ` (${l.pickup_date.slice(5, 7)}/${l.pickup_date.slice(8, 10)})` : l.created_at ? ` (${new Date(l.created_at).toLocaleDateString()})` : '';
  return [head, l.broker_name].filter(Boolean).join(' · ') + when;
}

const IMG = /\.(jpe?g|png|webp|gif)$/i;
export const isImagePath = (p) => IMG.test(String(p || ''));

// A loads row with stops(*) → the fields suggestLoad uses (pickup/delivery dates from stop appointments,
// reference numbers from stops.pickup_number and the notes' "Refs: ..." line).
export function loadForSuggest(l) {
  const stops = [...(l?.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const day = (s) => (s?.appointment_start ? String(s.appointment_start).slice(0, 10) : null);
  const pick = stops.find((s) => s.stop_type === 'pickup') || stops[0];
  const drop = [...stops].reverse().find((s) => s.stop_type === 'delivery') || stops[stops.length - 1];
  const refLine = /refs?:\s*([^\n]+)/i.exec(String(l?.notes || ''))?.[1] || '';
  const refs = [...stops.map((s) => s.pickup_number), ...refLine.split(/[,;]/)].map((x) => String(x || '').trim()).filter(Boolean)
    .flatMap((r) => { const bare = r.replace(/^[^0-9]*?[:#]\s*/, '').trim(); return bare && bare !== r ? [r, bare] : [r]; });
  return { id: l.id, broker_load_number: l.broker_load_number, broker_name: l.broker_name, status: l.status, assigned_driver_user_id: l.assigned_driver_user_id || null,
    created_at: l.created_at, pickup_date: day(pick), delivery_date: day(drop), reference_numbers: refs };
}
