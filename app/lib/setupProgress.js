// Pure checklist math: what applies, what is done, progress, filters, roadside and driver-file cards.
// No I/O. Dates are YYYY-MM-DD strings.

import {
  CHECKLIST_ITEMS, CATEGORIES, CATEGORY_NAME, GUIDANCE, answerApplies, itemByKey,
  DRIVER_FILE_DOC_TYPES, ROADSIDE_CATEGORY_KEYS,
} from './setupCatalog.js';
import {
  addDays, addMonths, daysBetween, isISODate, nextMcs150Due, ucrCycle, form2290Dues, iftaDue,
} from './complianceCalendar.js';
import { localISODate } from './localDate.js';

export const EQUIPMENT_RECHECK_DAYS = 365;
export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'missing', label: 'Missing' },
  { id: 'expiring', label: 'Expiring soon' },
  { id: 'expired', label: 'Expired' },
  { id: 'done', label: 'Done' },
  { id: 'skipped', label: 'Skipped / Not needed' },
];

export function scopeIdOf(doc) {
  const parts = String(doc?.file_path || '').split('/');
  if (parts[1] !== 'checklist') return null;
  return parts[3] || null;
}
export function equipmentCurrent(checkedAt, today) {
  const day = String(checkedAt || '').slice(0, 10);
  if (!isISODate(day) || !isISODate(today)) return false;
  return addDays(day, EQUIPMENT_RECHECK_DAYS) >= today;
}

function withMarker(extra, row, file, ctx) {
  const mark = markerOf(row, extra?.done || extra?.bucket === 'done' ? file : null);
  if (!mark) return { ...extra, ticked: false, markedBy: null };
  const known = (ctx.people || {})[mark.id] || {};
  const person = { email: known.email || null, name: usableName(known.name, known.email) || driverDisplayName(ctx, mark.id, row) || null };
  const line = markedDoneLine(person, mark.at);
  return { ...extra, ticked: !!mark.ticked, markedBy: extra?.done ? line : null, checkedBy: mark.id, checkedAt: String(mark.at || '').slice(0, 10) || null };
}

function blank(item, inst, extra) {
  return {
    itemKey: item.key, title: item.title, description: item.description || '', citation: item.citation || '',
    category: item.category, categoryName: CATEGORY_NAME[item.category] || item.category,
    level: item.level, kinds: item.kinds, verified: item.verified !== false, scope: item.scope,
    driverAccess: item.driverAccess, wizardStep: item.wizardStep, docType: item.docType || null,
    echoOf: item.echoOf || null, warningDays: item.warningDays || 30, expiry: item.expiry || 'none',
    truckId: inst.truckId || null, trailerId: inst.trailerId || null, driverId: inst.driverId || null,
    unitLabel: inst.label || null, applicable: true, skipped: false, done: false, counts: true,
    bucket: 'missing', detail: '', expiryOn: null, needs: inst.needs || null, uploadedAt: null,
    fileName: null, documentId: null, help: GUIDANCE, ...extra,
  };
}

export function instancesFor(item, ctx) {
  const answers = ctx.answers || {};
  if (!answerApplies(item.when, answers)) {
    return [{ applicable: false, label: null }];
  }
  if (item.scope === 'company') return [{ label: null }];
  if (item.scope === 'driver') {
    const drivers = ctx.drivers || [];
    if (!drivers.length) return [{ needs: 'driver', label: 'No driver yet' }];
    return drivers.map((d) => ({ driverId: d.id, truckId: d.truck_id || null, label: d.name || 'Driver' }));
  }
  if (item.scope === 'truck') {
    const trucks = ctx.trucks || [];
    if (!trucks.length) return [{ needs: 'truck', label: 'No truck yet' }];
    return trucks.map((t) => ({ truckId: t.id, label: t.unit_number ? `Truck ${t.unit_number}` : 'Truck' }));
  }
  if (item.scope === 'unit') {
    const trucks = (ctx.trucks || []).map((t) => ({ truckId: t.id, label: t.unit_number ? `Truck ${t.unit_number}` : 'Truck' }));
    const trailers = (ctx.trailers || []).map((t) => ({
      trailerId: t.id, truckId: t.pulled_by || null, label: t.unit_number ? `Trailer ${t.unit_number}` : 'Trailer',
    }));
    const units = [...trucks, ...trailers];
    if (!units.length) return [{ needs: 'truck', label: 'No truck yet' }];
    return units;
  }
  return [{ label: null }];
}

function statusRow(ctx, item, inst) {
  return (ctx.statuses || []).find((r) => r.item_key === item.key
    && (r.truck_id || null) === (inst.truckId || null)
    && (r.trailer_id || null) === (inst.trailerId || null)
    && (r.driver_id || null) === (inst.driverId || null)) || null;
}

function docsFor(item, inst, ctx) {
  if (!item.docType) return [];
  return (ctx.documents || []).filter((d) => {
    if (!d || d.doc_type !== item.docType) return false;
    const scope = d.scope_id || scopeIdOf(d);
    if (inst.driverId) return scope === inst.driverId || d.driver_id === inst.driverId;
    if (inst.trailerId) return scope === inst.trailerId || d.trailer_id === inst.trailerId;
    if (inst.truckId && item.scope !== 'company') return d.truck_id === inst.truckId || scope === inst.truckId;
    return !d.truck_id && !d.trailer_id && !d.driver_id && scope !== 'truck';
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function filedBetween(docs, from, to) {
  return (docs || []).some((d) => {
    const c = String(d.created_at || '').slice(0, 10);
    return isISODate(c) && c >= from && c <= to;
  });
}

// A renewal is still done until its due date when an older filing covers the previous cycle.
// After the due date, only a filing in the current cycle (or a completed reminder) counts.
export function cycleState({ today, due, cycleMonths, docs, warningDays = 30, periodCompleted = false }) {
  if (!isISODate(due)) return { bucket: docs?.length ? 'done' : 'missing', done: !!docs?.length, expiryOn: null };
  if (periodCompleted) return { bucket: 'done', done: true, expiryOn: due };
  // A filing just after the previous deadline still belongs to that deadline.
  // This cycle's filing is one dated in the second half of the cycle, through the due date.
  const half = Math.max(1, Math.round(cycleMonths / 2));
  const midpoint = addMonths(due, -half);
  const prev = addMonths(due, -cycleMonths);
  const prevMid = addMonths(prev, -half);
  const filedThis = filedBetween(docs, midpoint, due);
  const coveredByPrev = filedBetween(docs, prevMid, addDays(midpoint, -1));
  if (today > due && !filedThis) return { bucket: 'expired', done: false, expiryOn: due };
  if (filedThis) return { bucket: 'done', done: true, expiryOn: due };
  if (coveredByPrev && today <= due) {
    if (daysBetween(today, due) <= warningDays) return { bucket: 'expiring', done: true, expiryOn: due };
    return { bucket: 'done', done: true, expiryOn: due };
  }
  return { bucket: 'missing', done: false, expiryOn: due };
}

function reminderDone(ctx, ruleKey, period) {
  return (ctx.reminders || []).some((r) => r.rule_key === ruleKey && r.period === period && r.status === 'completed');
}

function dateState(expiryOn, today, warningDays, hasProof) {
  if (!isISODate(expiryOn)) return hasProof ? { bucket: 'done', done: true, expiryOn: null } : { bucket: 'missing', done: false, expiryOn: null };
  if (expiryOn < today) return { bucket: 'expired', done: false, expiryOn };
  if (daysBetween(today, expiryOn) <= warningDays) return { bucket: 'expiring', done: !!hasProof, expiryOn };
  return hasProof ? { bucket: 'done', done: true, expiryOn } : { bucket: 'missing', done: false, expiryOn };
}

function driverOf(ctx, id) {
  return (ctx.drivers || []).find((d) => d.id === id) || null;
}

function specialState(item, inst, ctx, docs, row) {
  const today = ctx.today;
  const warn = item.warningDays || 30;
  if (item.expiry === 'mcs150') {
    const due = nextMcs150Due(ctx.dot, addDays(today, -1));
    if (!due) return { bucket: docs.length || row?.status === 'done' ? 'done' : 'missing', done: !!(docs.length || row?.status === 'done'), expiryOn: null, detail: 'Enter a USDOT number with at least two digits to calculate the MCS-150 month.' };
    const period = `mcs150-${due.slice(0, 7)}`;
    const state = cycleState({ today, due, cycleMonths: 24, docs, warningDays: warn, periodCompleted: reminderDone(ctx, 'mcs150', period) });
    return { ...state, detail: `Next MCS-150 due ${due}.` };
  }
  if (item.expiry === 'ucr') {
    const ucr = ucrCycle(today);
    const windowStart = ucr.opens;
    const priorStart = addMonths(windowStart, -12);
    const filedNext = reminderDone(ctx, 'ucr', ucr.period) || filedBetween(docs, windowStart, ucr.due);
    const filedCurrent = filedBetween(docs, priorStart, addDays(windowStart, -1)) || filedNext;
    if (ucr.open) {
      if (filedNext) return { bucket: 'done', done: true, expiryOn: ucr.due, detail: `UCR ${ucr.registrationYear} receipt is on file. Due before January 1.` };
      if (daysBetween(today, ucr.due) <= warn) return { bucket: 'expiring', done: false, expiryOn: ucr.due, detail: `UCR ${ucr.registrationYear} is due before January 1 (${ucr.due}).` };
      return { bucket: filedCurrent ? 'done' : 'missing', done: filedCurrent, expiryOn: ucr.due, detail: `UCR ${ucr.registrationYear} window is open. Pay before January 1.` };
    }
    return { bucket: filedCurrent ? 'done' : 'missing', done: filedCurrent, expiryOn: ucr.due, detail: `Next UCR window opens ${ucr.opens}.` };
  }
  if (item.expiry === 'quarterly') {
    const y = Number(today.slice(0, 4));
    const candidates = [];
    for (const year of [y - 1, y, y + 1]) {
      for (let q = 1; q <= 4; q++) candidates.push({ q, due: iftaDue(year, q), period: `ifta-${year}-Q${q}` });
    }
    candidates.sort((a, b) => a.due.localeCompare(b.due));
    const chosen = candidates.find((c) => c.due >= addDays(today, -45));
    if (!chosen) return { bucket: 'missing', done: false, expiryOn: null, detail: '' };
    const filed = reminderDone(ctx, 'ifta_quarter', chosen.period);
    if (filed) return { bucket: 'done', done: true, expiryOn: chosen.due, detail: `IFTA Q${chosen.q} filed.` };
    if (today > chosen.due) return { bucket: 'expired', done: false, expiryOn: chosen.due, detail: `IFTA Q${chosen.q} was due ${chosen.due}.` };
    if (daysBetween(today, chosen.due) <= warn) return { bucket: 'expiring', done: false, expiryOn: chosen.due, detail: `IFTA Q${chosen.q} due ${chosen.due}.` };
    return { bucket: 'missing', done: false, expiryOn: chosen.due, detail: `IFTA Q${chosen.q} due ${chosen.due}.` };
  }
  if (item.key === 'form_2290' || item.expiry === '2290') {
    const dues = form2290Dues(ctx.hvutFirstUseOn, today);
    const due = dues.find((d) => d >= addDays(today, -45)) || dues.at(-1) || null;
    if (!due) return { bucket: docs.length ? 'done' : 'missing', done: !!docs.length, expiryOn: null, detail: 'Enter the month you first used a taxable vehicle.' };
    const state = cycleState({ today, due, cycleMonths: 12, docs, warningDays: warn, periodCompleted: reminderDone(ctx, 'form_2290', `2290-${due}`) });
    return { ...state, detail: `Form 2290 due ${due}.` };
  }
  return null;
}

function expiryOnFor(item, inst, ctx, row) {
  if (item.key === 'coi' || item.echoOf === 'coi') return ctx.coiExpiry || row?.expiry_on || null;
  if (item.key === 'medical_card') return row?.expiry_on || driverOf(ctx, inst.driverId)?.med_card_expiry || null;
  if (item.key === 'cdl') return row?.expiry_on || driverOf(ctx, inst.driverId)?.cdl_expiry || null;
  if (item.expiry === 'ifta_renewal') return ctx.iftaRenewalOn || row?.expiry_on || null;
  if (item.expiry === 'irp') return ctx.irpRenewalOn || row?.expiry_on || null;
  if (isISODate(row?.expiry_on)) return row.expiry_on;
  return null;
}

function doneRow(item, inst, ctx, row, file, extra) {
  return blank(item, inst, withMarker(extra, row, file, ctx));
}

export function resolveInstance(item, inst, ctx) {
  const row = statusRow(ctx, item, inst);
  if (inst.applicable === false || (row?.status === 'not_needed' && item.level !== 'required')) {
    return doneRow(item, inst, ctx, row, null, { applicable: false, counts: false, bucket: 'not_needed', done: false, detail: 'Not needed for this company.' });
  }
  if (inst.needs) {
    return doneRow(item, inst, ctx, row, null, { counts: false, needs: inst.needs, bucket: 'missing', detail: inst.needs === 'driver' ? 'Add a driver on the Truck tab.' : 'Add a truck on the Truck tab.' });
  }
  const docs = docsFor(item, inst, ctx);
  const today = ctx.today;
  const warn = item.warningDays || 30;
  const file = docs[0] || null;

  if (item.kinds.includes('equipment')) {
    const fresh = row?.status === 'done' && equipmentCurrent(row.checked_at, today);
    if (row?.status === 'skipped') {
      return doneRow(item, inst, ctx, row, file, { skipped: true, bucket: 'missing', done: false, detail: 'Skipped. Still shown as missing. Check again within a year of the last time it was marked on the truck.' });
    }
    if (fresh) return doneRow(item, inst, ctx, row, file, { bucket: 'done', done: true, detail: `Checked ${String(row.checked_at).slice(0, 10)}. Check again in a year.` });
    if (row?.status === 'done') return doneRow(item, inst, ctx, row, file, { bucket: 'missing', done: false, detail: `Last checked ${String(row.checked_at).slice(0, 10)}. Check this equipment again.` });
    return doneRow(item, inst, ctx, row, file, { bucket: 'missing', done: false, detail: 'Check this on the truck. It is checked again every year.' });
  }

  const special = specialState(item, inst, ctx, docs, row);
  if (special) {
    const skipped = !special.done && row?.status === 'skipped';
    return doneRow(item, inst, ctx, row, file, {
      ...special, skipped, uploadedAt: file?.created_at || null, fileName: file?.original_filename || null, documentId: file?.id || row?.document_id || null,
      detail: special.detail || '',
    });
  }

  const expiryOn = expiryOnFor(item, inst, ctx, row);
  const hasUpload = !!file;
  const marked = row?.status === 'done';
  const hasProof = hasUpload || (marked && !item.docType);
  // An upload item is done from the file. A tick alone does not replace the file.
  const proof = item.docType ? hasUpload : (hasUpload || marked);
  let state = dateState(item.expiry === 'none' ? null : expiryOn, today, warn, proof);
  if (item.expiry === 'none') state = proof ? { bucket: 'done', done: true, expiryOn: null } : { bucket: 'missing', done: false, expiryOn: null };
  if (item.expiry === 'yearly' || item.expiry === 'date' || item.expiry === 'policy' || item.expiry === 'ifta_renewal' || item.expiry === 'irp') {
    state = dateState(expiryOn, today, warn, proof);
    if (!expiryOn && proof) state = { bucket: 'done', done: true, expiryOn: null };
  }
  if (!state.done && row?.status === 'skipped') {
    return doneRow(item, inst, ctx, row, file, { skipped: true, bucket: 'missing', done: false, expiryOn: state.expiryOn, detail: 'Skipped. Still shown as missing.', uploadedAt: file?.created_at || null, fileName: file?.original_filename || null });
  }
  const detail = state.bucket === 'expired' ? `Expired ${state.expiryOn}.` : state.bucket === 'expiring' ? `Expires ${state.expiryOn}.` : state.done && file ? `On file ${localISODate(file.created_at) || String(file.created_at).slice(0, 10)}.` : state.done ? 'Marked done.' : '';
  return doneRow(item, inst, ctx, row, file, {
    ...state, detail, uploadedAt: file?.created_at || null, fileName: file?.original_filename || null, documentId: file?.id || null,
  });
}

export function buildChecklist(ctx) {
  const rows = [];
  for (const item of CHECKLIST_ITEMS) {
    if (item.echoOf) continue;
    for (const inst of instancesFor(item, ctx)) rows.push(resolveInstance(item, inst, ctx));
  }
  return rows;
}

export function summarize(rows) {
  const required = rows.filter((r) => r.counts && r.applicable && r.level === 'required');
  const recommended = rows.filter((r) => r.counts && r.applicable && r.level === 'recommended');
  const requiredDone = required.filter((r) => r.done).length;
  return {
    requiredDone, requiredTotal: required.length,
    recommendedDone: recommended.filter((r) => r.done).length, recommendedTotal: recommended.length,
    percent: required.length ? Math.round((requiredDone / required.length) * 100) : 100,
    // A skipped or missing required item never blocks loads or anything else.
    blocks: false,
  };
}

export function matchesFilter(row, filter) {
  if (row.needs) return filter === 'all' || filter === 'missing';
  if (filter === 'all') return row.applicable;
  if (filter === 'missing') return row.applicable && !row.done && row.bucket === 'missing';
  if (filter === 'expiring') return row.bucket === 'expiring';
  if (filter === 'expired') return row.bucket === 'expired';
  if (filter === 'done') return row.applicable && row.done;
  if (filter === 'skipped') return row.skipped || !row.applicable;
  return true;
}
export function filterCounts(rows) {
  const out = {};
  for (const f of FILTERS) out[f.id] = rows.filter((r) => matchesFilter(r, f.id)).length;
  return out;
}

function rowMatchesUnit(row, inst) {
  if (inst.driverId) return row.driverId === inst.driverId;
  if (inst.trailerId) return row.trailerId === inst.trailerId;
  if (inst.truckId) return row.truckId === inst.truckId && !row.trailerId && !row.driverId;
  return !row.truckId && !row.trailerId && !row.driverId;
}

// Binder lines for one truck: own binder rows plus echoes of the linked upload.
export function binderLines(truck, ctx, rows) {
  if (!truck) return [];
  const driver = (ctx.drivers || []).find((d) => d.truck_id === truck.id) || null;
  const trailer = (ctx.trailers || []).find((t) => t.id === truck.current_trailer_id) || null;
  const lines = [];
  for (const item of CHECKLIST_ITEMS) {
    const show = item.category === 'binder' || item.category === 'hazmat' || (item.kinds.includes('binder') && !item.echoOf && item.category === 'loads');
    if (!show || (!item.kinds.includes('binder') && !item.echoOf)) continue;
    if (!item.echoOf && item.category !== 'binder' && item.category !== 'hazmat' && item.category !== 'loads') continue;
    const source = item.echoOf ? itemByKey(item.echoOf) : item;
    if (!source) continue;
    if (!answerApplies(item.when || source.when, ctx.answers)) continue;
    let inst = { truckId: truck.id, label: truck.unit_number ? `Truck ${truck.unit_number}` : 'Truck' };
    if (source.scope === 'driver') {
      if (!driver) continue;
      inst = { driverId: driver.id, truckId: truck.id, label: driver.name };
    } else if (source.scope === 'company') inst = { label: null };
    else if (source.scope === 'unit' && item.echoOf) {
      // Truck's own inspection, and the trailer's if one is hooked.
      const own = rows.find((r) => r.itemKey === source.key && r.truckId === truck.id && !r.trailerId);
      if (own?.applicable) lines.push(presentLine(item, source, own));
      if (trailer) {
        const tr = rows.find((r) => r.itemKey === source.key && r.trailerId === trailer.id);
        if (tr?.applicable) lines.push(presentLine(item, source, tr, trailer.unit_number ? `Trailer ${trailer.unit_number}` : 'Trailer'));
      }
      continue;
    }
    const found = rows.find((r) => r.itemKey === source.key && rowMatchesUnit(r, inst) && r.applicable);
    if (!found && source.scope === 'company') {
      const companyRow = rows.find((r) => r.itemKey === source.key && !r.truckId && !r.driverId && !r.trailerId);
      if (companyRow) lines.push(presentLine(item, source, companyRow));
      continue;
    }
    if (found) lines.push(presentLine(item, source, found));
  }
  return lines;
}
function presentLine(display, source, row, label) {
  return {
    ...row,
    title: label ? `${display.title} (${label})` : display.title,
    displayKey: display.key,
    verified: display.verified !== false && source.verified !== false,
    level: display.level || row.level,
    description: display.description || row.description,
  };
}

export function roadsideForTruck(truck, ctx, rows) {
  const lines = [];
  const seen = new Set();
  const consider = (item) => {
    if (!ROADSIDE_CATEGORY_KEYS.has(item.category) && !(item.kinds.includes('binder') && item.category === 'loads')) return;
    const source = item.echoOf ? itemByKey(item.echoOf) : item;
    if (!source || source.level !== 'required') return;
    if (seen.has(source.key + (source.scope === 'unit' ? ':unit' : ''))) return;
    const related = binderLines(truck, ctx, rows).filter((l) => l.itemKey === source.key || l.displayKey === item.key);
    const direct = rows.filter((r) => r.itemKey === source.key && r.applicable && r.counts && r.level === 'required' && (
      r.truckId === truck.id || (!r.truckId && !r.driverId && source.scope === 'company') || (source.scope === 'driver' && r.truckId === truck.id)
    ));
    const picked = direct.length ? direct : related.filter((r) => r.level === 'required' || source.level === 'required');
    if (!picked.length) return;
    seen.add(source.key);
    for (const row of (direct.length ? direct : related)) {
      if (row.level !== 'required' && source.level !== 'required') continue;
      if (!row.applicable) continue;
      lines.push(row);
    }
  };
  for (const item of CHECKLIST_ITEMS) consider(item);
  const uniq = [];
  const ids = new Set();
  for (const row of lines) {
    const id = `${row.itemKey}:${row.truckId || ''}:${row.trailerId || ''}:${row.driverId || ''}`;
    if (ids.has(id)) continue;
    ids.add(id);
    if (row.level !== 'required') continue;
    uniq.push(row);
  }
  const done = uniq.filter((r) => r.done && r.bucket !== 'expired').length;
  const nextExpiry = uniq.filter((r) => r.done && isISODate(r.expiryOn)).sort((a, b) => a.expiryOn.localeCompare(b.expiryOn))[0] || null;
  return { done, total: uniq.length, items: uniq, nextExpiry };
}

export function driverFileRows(driverId, rows) {
  return rows.filter((r) => r.category === 'driver_files' && r.driverId === driverId && r.applicable && r.counts);
}

export function modelFromPayload(payload, today) {
  const profile = payload?.profile || {};
  return {
    today,
    dot: profile.dot_number || '',
    answers: profile.operation_answers || {},
    iftaRenewalOn: profile.ifta_renewal_on || null,
    irpRenewalOn: profile.irp_renewal_on || null,
    hvutFirstUseOn: profile.hvut_first_use_on || null,
    coiExpiry: payload?.coiExpiry || null,
    trucks: payload?.trucks || [],
    trailers: payload?.trailers || [],
    drivers: payload?.drivers || [],
    documents: payload?.documents || [],
    statuses: payload?.statuses || [],
    reminders: payload?.reminders || [],
    people: payload?.people || {},
    role: payload?.role || null,
    userId: payload?.userId || null,
  };
}

// Automatic guide only for a company created in the last day that has not been used yet.
// Anything older, or a company that already has trucks, drivers, paperwork, or loads, gets one prompt.
export const NEW_COMPANY_MS = 24 * 60 * 60 * 1000;
export function companyAlreadyUsed(activity = {}) {
  return !!(activity.trucks || activity.drivers || activity.documents || activity.loads);
}
export function setupEntry(profile, role, now = Date.now(), activity = {}) {
  if (!profile || role !== 'owner') return null;
  if (profile.setup_started_at || profile.setup_prompted_at || profile.setup_completed_at) return null;
  const created = Date.parse(profile.created_at || '');
  const recent = Number.isFinite(created) && now - created >= 0 && now - created < NEW_COMPANY_MS;
  if (recent && !companyAlreadyUsed(activity)) return 'guide';
  return 'prompt';
}

function usableName(name, email) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  if (!n) return '';
  if (e && n.toLowerCase() === e.toLowerCase()) return '';
  return n;
}

export function personLabel(person) {
  const name = usableName(person?.name, person?.email);
  if (name) return name;
  const email = String(person?.email || '').trim();
  return email || null;
}

// The name on the drivers row, when this user is that driver. Profile text that is just the email does not count.
export function driverDisplayName(ctx, userId, row) {
  const drivers = ctx?.drivers || [];
  const linked = drivers.find((d) => d.auth_user_id && String(d.auth_user_id) === String(userId) && String(d.name || '').trim());
  if (linked) return String(linked.name).trim();
  if (ctx?.role !== 'driver') return null;
  if (ctx.userId && String(ctx.userId) !== String(userId)) return null;
  if (row?.driverId) {
    const named = drivers.find((d) => d.id === row.driverId && String(d.name || '').trim());
    if (named) return String(named.name).trim();
  }
  if (row?.truckId) {
    const onTruck = drivers.filter((d) => d.truck_id === row.truckId && String(d.name || '').trim());
    if (onTruck.length === 1) return String(onTruck[0].name).trim();
  }
  const named = drivers.filter((d) => String(d.name || '').trim());
  return named.length === 1 ? String(named[0].name).trim() : null;
}

// Fill names for driver members: linked driver row, then the driver on the ticked truck, then the only unlinked driver.
export function applyDriverNames(people, ids, { drivers = [], members = [], statuses = [] } = {}) {
  const out = {};
  for (const id of ids || []) out[id] = { name: people?.[id]?.name ?? null, email: people?.[id]?.email ?? null };
  for (const d of drivers) {
    const name = String(d.name || '').trim();
    if (!d.auth_user_id || !name || !out[d.auth_user_id]) continue;
    out[d.auth_user_id] = { ...out[d.auth_user_id], name };
  }
  const driverMembers = new Set((members || []).filter((m) => m.role === 'driver' && m.user_id).map((m) => m.user_id));
  for (const id of Object.keys(out)) {
    if (!driverMembers.has(id) || usableName(out[id].name, out[id].email)) continue;
    const name = nameFromTicks(id, statuses, drivers);
    if (name) out[id] = { ...out[id], name };
  }
  const open = Object.keys(out).filter((id) => driverMembers.has(id) && !usableName(out[id].name, out[id].email));
  const free = drivers.filter((d) => String(d.name || '').trim() && !d.auth_user_id);
  if (open.length === 1 && free.length === 1) out[open[0]] = { ...out[open[0]], name: String(free[0].name).trim() };
  for (const id of Object.keys(out)) {
    if (!usableName(out[id].name, out[id].email)) out[id] = { ...out[id], name: null };
  }
  return out;
}

function nameFromTicks(userId, statuses, drivers) {
  const mine = (statuses || []).filter((s) => s.checked_by === userId);
  const driverIds = [...new Set(mine.map((s) => s.driver_id).filter(Boolean))];
  if (driverIds.length === 1) {
    const d = drivers.find((x) => x.id === driverIds[0] && String(x.name || '').trim());
    if (d) return String(d.name).trim();
  }
  const trucks = [...new Set(mine.map((s) => s.truck_id).filter(Boolean))];
  if (!trucks.length) return null;
  const names = new Set();
  for (const tid of trucks) {
    const on = drivers.filter((d) => d.truck_id === tid && String(d.name || '').trim());
    if (on.length !== 1) return null;
    names.add(String(on[0].name).trim());
  }
  return names.size === 1 ? [...names][0] : null;
}

// Undo a tick that did not upload a file, and undo a skip back to not done.
export function showUndo(row, office) {
  if (!row?.applicable || row.needs) return false;
  if (row.skipped) return !!(office || row.driverAccess === 'equipment');
  if (!row.ticked || !row.done) return false;
  if (row.docType && row.documentId) return false;
  if (row.driverAccess === 'equipment') return true;
  if (!office) return false;
  return (row.kinds || []).includes('audit') || (row.kinds || []).includes('binder') || (row.kinds || []).includes('equipment');
}

// Who completed a done item: the tick if there is one, otherwise the person who uploaded the file.
export function markerOf(row, file) {
  if (row?.status === 'done' && row.checked_by) return { id: row.checked_by, at: row.checked_at || null, ticked: true };
  if (file?.user_id) return { id: file.user_id, at: file.created_at || null, ticked: false };
  return null;
}
export function markedDoneLine(person, at) {
  const label = personLabel(person);
  const day = String(at || '').slice(0, 10);
  if (!label || !isISODate(day)) return null;
  return `Marked done by ${label} on ${day}.`;
}

export function visibleToRole(row, role) {
  if (role !== 'driver') return true;
  return row.driverAccess === 'equipment' || row.driverAccess === 'binder' || row.category === 'binder' || row.category === 'hazmat' || row.category === 'equipment';
}

// Calendar rows from dates already entered on checklist items (medical card, COI, inspection, …).
export function expiryEntries(rows, today) {
  const out = [];
  for (const row of rows) {
    if (!row.applicable || !isISODate(row.expiryOn)) continue;
    if (['mcs150', 'ucr', 'quarterly', '2290'].includes(itemByKey(row.itemKey)?.expiry)) continue;
    if (daysBetween(today, row.expiryOn) < -45 || daysBetween(today, row.expiryOn) > 400) continue;
    out.push({
      ruleKey: `expiry:${row.itemKey}`, period: `${row.itemKey}:${row.expiryOn}:${row.truckId || ''}:${row.driverId || ''}:${row.trailerId || ''}`,
      due: row.expiryOn, title: row.unitLabel ? `${row.title} (${row.unitLabel})` : row.title,
      itemKey: row.itemKey, truckId: row.truckId, driverId: row.driverId, needs: row.docType ? 'upload' : 'audit',
      detail: row.bucket === 'expired' ? `Expired ${row.expiryOn}.` : `Expires ${row.expiryOn}.`,
      completed: false, dismissed: false, opens: null,
    });
  }
  return out;
}

export { CATEGORIES };
