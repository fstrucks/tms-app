// Home page "Current load" card (Marc's hybrid pick, Oct 18 2026). Pure helpers: no React/DOM.
// Unit-tested in tests/js/homeCurrentLoad.test.mjs. Design: docs/design/home-current-load.md.
//
//  * Which load: in transit, then dispatched, then in transit > 24 h past delivery ("overdue", Oct 20 2026), then
//    booked (stale booked loads skipped); ties go to the earliest pickup (groupLoads in loadTabs.js).
//  * Layout: 'A' (pickup and delivery side by side) for one pickup + one drop; 'B' (next stop first, countdown,
//    other stops folded) when the load has more than two stops.
//  * Rate (Marc, 9:16 PM CT): the owner always sees it. A driver sees it only on loads assigned to him with
//    show_rate_to_driver on. Enforced in the database by public.visible_loads() (migration 20261018000600):
//    the card shows whatever rate that function returns (can_see_rate), and never computes access itself.
//  * Members (management / dispatcher / driver) read loads only through visible_loads(). Until that migration
//    is applied the card falls back to the owner's own-row select, and members get no card (never a false empty).
import { completedNextIndex } from './stopProgress.js';
import { groupLoads, sortedStops, pickupStop, deliveryStop } from './loadTabs';
import { fmtMoney } from './money';

export const CARD_STATUSES = ['in_transit', 'dispatched', 'booked'];
export const STALE_BOOKED_MS = 24 * 3600 * 1000; // booked load whose pickup is > 24 h in the past: skipped
export const AMBER_MS = 2 * 3600 * 1000; // countdown turns amber under 2 h
export const PASSED_STOP_GRACE_MS = 2 * 3600 * 1000; // in transit: a middle stop this long past its appt counts as done
export const OVERDUE_TRANSIT_MS = 24 * 3600 * 1000; // in transit > 24 h past the delivery appt: probably delivered, not marked

// An In transit load whose delivery appointment (end, else start) is more than 24 h in the past. It most likely
// was delivered and never marked, so it ranks below current loads and the card asks "Delivered?" (Oct 20 2026).
export function isOverdueInTransit(load, now = Date.now()) {
  if (load?.status !== 'in_transit') return false;
  const d = deliveryStop(load);
  const t = ts(d?.appointment_end) ?? ts(d?.appointment_start);
  return t !== null && t + OVERDUE_TRANSIT_MS < now;
}

// Owner fallback select (before 20261018000600). Owner-only: own-row RLS returns nothing to members.
export const HOME_LOAD_COLS = 'id, status, broker_name, broker_load_number, rate, rate_per_mile, total_miles, miles_source, notes, created_at, stops(*)';
export const HOME_LOAD_COLS_NO_SOURCE = 'id, status, broker_name, broker_load_number, rate, rate_per_mile, total_miles, notes, created_at, stops(*)';

const cityState = (stop) => [stop?.city, stop?.state].filter(Boolean).join(', '); // same as lib/loads (which pulls in JSX)
const ts = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; };
const pickupAt = (l) => ts(pickupStop(l)?.appointment_start);

// Booked loads that may show: pickup not more than 24 h ago. Undated booked loads only when no booked load is dated.
export function eligibleBooked(loads, now = Date.now()) {
  const booked = (loads || []).filter((l) => l?.status === 'booked');
  const dated = booked.filter((l) => pickupAt(l) !== null && pickupAt(l) >= now - STALE_BOOKED_MS);
  // Undated booked loads (no pickup appointment yet) come AFTER the dated ones instead of being dropped, so a
  // freshly created load without a date still shows in Up next (QA-101-D).
  const undated = booked.filter((l) => pickupAt(l) === null).sort((a, b) => (ts(b.created_at) || 0) - (ts(a.created_at) || 0));
  return [...(dated.length ? groupLoads(dated, 'booked').flatMap((g) => g.loads) : []), ...undated];
}

const ordered = (loads, status) => groupLoads((loads || []).filter((l) => l?.status === status), 'active').flatMap((g) => g.loads);

// In transit loads split: current ones (earliest pickup first, as the Loads page "On the road" bar) and overdue ones.
export function transitSplit(loads, now = Date.now()) {
  const transit = ordered(loads, 'in_transit');
  return { fresh: transit.filter((l) => !isOverdueInTransit(l, now)), overdue: transit.filter((l) => isOverdueInTransit(l, now)) };
}

// → { load, kind: 'current' | 'next' | 'empty', status, more, overdue, moreOverdue }.
// Order: current In transit, then Dispatched, then overdue In transit (> 24 h past delivery), then Booked.
// more = other loads with the card's status; moreOverdue = how many of those are overdue In transit.
export function pickCurrentLoad(loads, now = Date.now()) {
  const { fresh, overdue } = transitSplit(loads, now);
  if (fresh.length) return { load: fresh[0], kind: 'current', status: 'in_transit', more: fresh.length - 1 + overdue.length, overdue: false, moreOverdue: overdue.length };
  const disp = ordered(loads, 'dispatched');
  if (disp.length) return { load: disp[0], kind: 'current', status: 'dispatched', more: disp.length - 1, overdue: false, moreOverdue: 0 };
  if (overdue.length) return { load: overdue[0], kind: 'current', status: 'in_transit', more: overdue.length - 1, overdue: true, moreOverdue: overdue.length - 1 };
  const booked = eligibleBooked(loads, now);
  if (booked.length) return { load: booked[0], kind: 'next', status: 'booked', more: 0, overdue: false, moreOverdue: 0 };
  return { load: null, kind: 'empty', status: null, more: 0, overdue: false, moreOverdue: 0 };
}

export function moreLine(pick) {
  if (!pick?.more) return null;
  if (pick.status !== 'in_transit') return `${pick.more} more dispatched`;
  const od = pick.moreOverdue || 0;
  if (!od) return `${pick.more} more on the road`;
  if (od === pick.more) return `${od} more in transit past delivery (mark as delivered?)`;
  return `${pick.more - od} more on the road · ${od} past delivery`;
}

// "Up next": the next 2 booked loads (same order and stale rule as above), then overdue In transit loads (so a
// newer booked load always comes before a stale one), never the load already on the card.
export function upNext(loads, current, now = Date.now(), n = 2) {
  const { overdue } = transitSplit(loads, now);
  return [...eligibleBooked(loads, now), ...overdue].filter((l) => l.id !== current?.id).slice(0, n);
}

// "Delivered? Mark as delivered": the owner marks it through the same loads.update the load page uses
// (app/loads/[id]/page.js changeStatus). Management / dispatchers get a link to the dispatch center. Drivers: text only.
export function deliveredPromptMode(audience, load) {
  const base = linkBaseFor(audience, load);
  return base === '/loads' ? 'button' : base === '/dispatch' ? 'link' : 'text';
}
export async function markDelivered(supabase, id) {
  const { data, error } = await supabase.from('loads').update({ status: 'delivered' }).eq('id', id).eq('status', 'in_transit').select('status').maybeSingle();
  if (error) return { ok: false, error };
  if (!data) return { ok: false, error: { message: 'not_updated' } };
  return { ok: true };
}

// Home "N rate cons waiting for review": the same rule as the Loads banner (EmailDraftsBanner / isEmailDraft):
// emailed rate cons not yet turned into a load, minus the "Not a rate con" ones.
export const rateconsWaitingText = (n) => (n > 0 ? (n === 1 ? '1 rate con waiting for review' : `${n} rate cons waiting for review`) : null);
export async function countRateconsWaiting(supabase) {
  const { count, error } = await supabase.from('documents').select('id', { count: 'exact', head: true })
    .eq('source', 'email').is('load_id', null).eq('doc_type', 'rate_confirmation')
    .or('extraction_error.is.null,extraction_error.neq.not_ratecon');
  return error ? 0 : (count || 0);
}

export const isMultiStop = (load) => sortedStops(load).length > 2;
export const layoutFor = (load) => (isMultiStop(load) ? 'B' : 'A');

export function routeLabel(load) {
  const a = cityState(pickupStop(load)) || pickupStop(load)?.company_name || '—';
  const b = cityState(deliveryStop(load)) || deliveryStop(load)?.company_name || '—';
  return `${a} → ${b}`;
}

// Option B: the stop to show first. Before in transit: the first stop. In transit: the first stop after stop 1
// whose appointment (end, else start) has not passed by more than 2 h, or that has no appointment; else the last
// stop. There is no per-stop "done" field today, so this is a best guess from the appointments and is shown as such.
// PR #115: when any stop has completion data (stops.completed_at), the next stop is the first one not completed,
// whatever the status. The appointment guess below is the fallback for loads with no completion data.
export function nextStopIndex(load, now = Date.now()) {
  const st = sortedStops(load);
  if (!st.length) return -1;
  const done = completedNextIndex(load);
  if (done !== null) return done;
  if (load?.status !== 'in_transit') return 0;
  for (let i = 1; i < st.length; i++) {
    const t = ts(st[i].appointment_end) ?? ts(st[i].appointment_start);
    if (t === null || t + PASSED_STOP_GRACE_MS > now) return i;
  }
  return st.length - 1;
}

export function fmtDuration(ms) {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 10) return m ? `${h} h ${m} min` : `${h} h`;
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

// Countdown to a stop's appointment → { text, tone: 'normal' | 'amber' | 'red' } or null without an appointment.
export function countdown(stop, now = Date.now()) {
  const start = ts(stop?.appointment_start);
  if (start === null) return null;
  const end = ts(stop?.appointment_end);
  if (now < start) {
    const left = start - now;
    return { text: `Due in ${fmtDuration(left)}`, tone: left < AMBER_MS ? 'amber' : 'normal' };
  }
  if (end !== null && now < end) return { text: `Window open, closes in ${fmtDuration(end - now)}`, tone: 'amber' };
  return { text: `Late by ${fmtDuration(now - (end ?? start))}`, tone: 'red' };
}
export const TONE_COLORS = { normal: 'var(--text)', amber: 'var(--warning)', red: 'var(--danger)' };
export const TONE_BG = { normal: 'var(--surface-2)', amber: 'var(--warning-bg)', red: 'var(--danger-bg)' };

// Pickup numbers from the notes' "Refs: ..." line (rate con reference numbers, see create_load_from_document).
// Only refs labeled as a pickup / PU number count: "PU# 4471", "Pickup #: A-12", "P/U 889", "Pickup Number 55".
const PU_RE = /^(?:p\s*\/\s*u|pu|pick[\s-]?up)\b\s*(?:#|no\.?|num(?:ber)?)?\s*[:#-]?\s*(.+)$/i;
export function pickupNumbers(notes) {
  const out = [];
  for (const line of String(notes || '').split(/\r?\n/)) {
    const m = line.match(/^\s*refs?\s*:\s*(.*)$/i);
    if (!m) continue;
    for (const raw of m[1].split(/[,;]/)) {
      const tok = raw.trim();
      const p = tok.match(PU_RE);
      if (p && /[0-9]/.test(p[1])) out.push(p[1].trim());
    }
  }
  return out;
}
export const PICKUP_FALLBACK = 'Pickup # — see rate con';

// Text for the pickup at position `i` among the load's pickups. When the count of PU numbers matches the count of
// pickups they're matched in order; otherwise every pickup lists all of them.
export function pickupNumberText(load, stop) {
  const own = String(stop?.pickup_number ?? '').trim(); // stops.pickup_number (20261018000600) wins
  if (own) return `Pickup # ${own}`;
  const nums = pickupNumbers(load?.notes);
  if (!nums.length) return PICKUP_FALLBACK;
  const pickups = sortedStops(load).filter((s) => s?.stop_type === 'pickup');
  const i = pickups.indexOf(stop);
  if (nums.length === pickups.length && i >= 0) return `Pickup # ${nums[i]}`;
  return `Pickup # ${nums.join(', ')}`;
}

// Who gets the card, from the user's own company_members rows (readable under RLS: user_id = auth.uid()).
// → 'owner' (owns a company profile, or has no company at all: a solo account owns its loads) | 'member'.
export function cardAudience(userId, memberRows) {
  const mine = (memberRows || []).filter((r) => r && (!userId || r.user_id === userId));
  if (!mine.length) return 'owner';
  return mine.some((r) => r.role === 'owner') ? 'owner' : 'member';
}

// "Also drives" (20261020000100): a Management / Dispatcher member who also drives sees the loads assigned to him
// on Home, like a driver (Dispatch keeps the whole company view). Plain drivers already get only their own loads
// from visible_loads(). → the loads for the card.
export const alsoDrives = (userId, memberRows) => (memberRows || []).some((r) => r && (!userId || r.user_id === userId) && r.also_drives === true && r.role !== 'owner');
export function homeLoadsFor(loads, userId, memberRows, audience) {
  if (audience !== 'member' || !alsoDrives(userId, memberRows)) return loads;
  return (loads || []).filter((l) => l && l.assigned_driver_user_id === userId);
}
// company_members select for Home: also_drives only exists after 20261020000100.
export async function fetchMyMemberRows(supabase, userId) {
  const q = (cols) => supabase.from('company_members').select(cols).eq('user_id', userId);
  let m = await q('user_id, role, also_drives');
  if (m.error && /also_drives/.test(m.error.message || '')) m = await q('user_id, role');
  return m;
}

export const STOP_LABEL = (s) => (s?.stop_type === 'pickup' ? 'Pickup' : s?.stop_type === 'delivery' ? 'Delivery' : 'Stop');

// PostgREST / Postgres "function not found" (migration not applied yet).
export const isMissingFunction = (error) => !!error && (error.code === 'PGRST202' || error.code === '42883' || /Could not find the function|function .* does not exist/i.test(error.message || ''));

// Loads for the card. → { loads, viaRpc, error }. viaRpc=false: owner fallback select (members get nothing).
export async function fetchHomeLoads(supabase, { missingSource = (e) => false } = {}) {
  const rpc = await supabase.rpc('visible_loads', { p_statuses: CARD_STATUSES });
  if (!rpc.error) return { loads: (rpc.data || []).map((r) => (r && r.visible_loads) || r), viaRpc: true, error: null };
  if (!isMissingFunction(rpc.error)) return { loads: null, viaRpc: true, error: rpc.error };
  const q = (cols) => supabase.from('loads').select(cols).in('status', CARD_STATUSES).order('created_at', { ascending: false });
  let res = await q(HOME_LOAD_COLS);
  if (res.error && missingSource(res.error)) res = await q(HOME_LOAD_COLS_NO_SOURCE);
  return { loads: res.error ? null : (res.data || []), viaRpc: false, error: res.error || null };
}

// Rate on the card: exactly what the server returned. With visible_loads() that is can_see_rate; on the owner
// fallback (no can_see_rate key) only the owner can have rows at all.
export function canShowRate(load, audience) {
  if (!load || load.rate == null || load.rate === '') return false;
  if (typeof load.can_see_rate === 'boolean') return load.can_see_rate;
  return audience === 'owner';
}
export function rateText(load) {
  if (load?.rate == null || load.rate === '') return null;
  const rpm = load.rate_per_mile != null && load.rate_per_mile !== '' ? ` · ${fmtMoney(load.rate_per_mile)}/mi` : '';
  return `Rate ${fmtMoney(load.rate)}${rpm}`;
}

// Where the card's load links go: the owner's /loads pages, or the dispatch center (/dispatch) for management
// and dispatchers. Drivers get no links (read-only card).
// The load's own viewer_role (from visible_loads) decides, so a member never gets a /loads/<id> link (that page is
// own-row only and would 404 for them): owner → /loads, management / dispatcher → /dispatch, driver (or unknown) → none.
// No viewer_role = the owner's own-row fallback select (before 20261018000600), so only the owner audience links.
export function linkBaseFor(audience, load) {
  const vr = load?.viewer_role;
  if (vr != null) return vr === 'owner' ? '/loads' : ['management', 'dispatcher'].includes(vr) ? '/dispatch' : null;
  return audience === 'owner' ? '/loads' : null;
}
