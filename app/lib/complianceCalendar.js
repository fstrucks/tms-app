// On-screen compliance dates. Due dates are computed, not stored.
// Weekend and holiday shifts use US federal holidays (the next business day).
// State holidays are not included: IFTA renewal and IRP are dates the company enters.

export const GUIDANCE = 'General guidance, not legal advice. Check with your state or FMCSA.';

export function iso(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function parseISO(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  return { y, m, d };
}
export function isISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const { y, m, d } = parseISO(value);
  return iso(y, m, d) === value && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}
export function addDays(value, n) {
  const { y, m, d } = parseISO(value);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function weekday(value) {
  const { y, m, d } = parseISO(value);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
export function addMonths(value, n) {
  const { y, m, d } = parseISO(value);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, Math.min(d, dim));
}

const holidayCache = new Map();
function nthWeekday(year, month, dow, n) {
  const firstDow = weekday(iso(year, month, 1));
  return 1 + ((dow - firstDow + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(year, month, dow) {
  const last = Number(lastDayOfMonth(year, month).slice(8));
  const lastDow = weekday(iso(year, month, last));
  return last - ((lastDow - dow + 7) % 7);
}
function observe(set, year, month, day) {
  const date = iso(year, month, day);
  const dow = weekday(date);
  if (dow === 6) set.add(addDays(date, -1));
  else if (dow === 0) set.add(addDays(date, 1));
  else set.add(date);
}

// US federal holidays, observed (Saturday → Friday, Sunday → Monday).
export function federalHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set();
  observe(set, year, 1, 1);
  observe(set, year, 6, 19);
  observe(set, year, 7, 4);
  observe(set, year, 11, 11);
  observe(set, year, 12, 25);
  set.add(iso(year, 1, nthWeekday(year, 1, 1, 3)));
  set.add(iso(year, 2, nthWeekday(year, 2, 1, 3)));
  set.add(iso(year, 5, lastWeekday(year, 5, 1)));
  set.add(iso(year, 9, nthWeekday(year, 9, 1, 1)));
  set.add(iso(year, 10, nthWeekday(year, 10, 1, 2)));
  set.add(iso(year, 11, nthWeekday(year, 11, 4, 4)));
  holidayCache.set(year, set);
  return set;
}
export function isWeekend(value) {
  const dow = weekday(value);
  return dow === 0 || dow === 6;
}
export function isFederalHoliday(value) {
  return federalHolidays(Number(String(value).slice(0, 4))).has(value);
}
// If the date is a Saturday, Sunday, or federal holiday, move forward to the next business day.
export function nextBusinessDay(value) {
  let d = value;
  for (let i = 0; i < 14; i++) {
    if (!isWeekend(d) && !isFederalHoliday(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

// MCS-150: last USDOT digit is the month (1=Jan … 9=Sep, 0=Oct). Next-to-last digit odd/even = odd/even years.
// Due the last day of that month. No weekend shift (the rule says the last day of the month). Every 24 months.
export function mcs150Schedule(dot) {
  const digits = String(dot || '').replace(/\D/g, '');
  if (digits.length < 2) return null;
  const last = Number(digits.at(-1));
  const prev = Number(digits.at(-2));
  return { month: last === 0 ? 10 : last, oddYears: prev % 2 === 1 };
}
export function mcs150DueDates(dot, fromYear, toYear) {
  const sch = mcs150Schedule(dot);
  if (!sch) return [];
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    if ((y % 2 === 1) !== sch.oddYears) continue;
    out.push(lastDayOfMonth(y, sch.month));
  }
  return out;
}
export function nextMcs150Due(dot, today) {
  const y = Number(String(today).slice(0, 4));
  return mcs150DueDates(dot, y - 3, y + 4).find((d) => d >= today) || null;
}

// IFTA quarterly returns: Apr 30, Jul 31, Oct 31, Jan 31, then the next business day.
export function iftaNominal(year, quarter) {
  if (quarter === 1) return iso(year, 4, 30);
  if (quarter === 2) return iso(year, 7, 31);
  if (quarter === 3) return iso(year, 10, 31);
  return iso(year + 1, 1, 31);
}
export function iftaDue(year, quarter) {
  return nextBusinessDay(iftaNominal(year, quarter));
}
export function iftaQuartersAround(today) {
  const y = Number(today.slice(0, 4));
  const out = [];
  for (let year = y - 1; year <= y + 1; year++) {
    for (let q = 1; q <= 4; q++) {
      const nominal = iftaNominal(year, q);
      const due = nextBusinessDay(nominal);
      out.push({
        ruleKey: 'ifta_quarter', period: `ifta-${year}-Q${q}`, quarter: q, year,
        nominal, due, itemKey: 'ifta_returns', title: `IFTA Q${q} ${year} return`,
        detail: nominal === due ? `Due ${due}` : `Due ${due} (${nominal} falls on a weekend or holiday)`,
      });
    }
  }
  return out;
}

// UCR: the next year's portal opens Oct 1; the fee is due before Jan 1 (last day shown is Dec 31).
export function ucrCycle(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return {
    ruleKey: 'ucr',
    period: `ucr-${y + 1}`,
    registrationYear: y + 1,
    opens: iso(y, 10, 1),
    due: iso(y, 12, 31),
    open: m >= 10,
    itemKey: 'ucr',
    title: `UCR ${y + 1} fee`,
    detail: `Window opens ${iso(y, 10, 1)}. Pay before January 1, ${y + 1}.`,
  };
}

// Form 2290: last day of the month after first use, then the next business day. Later years are due at the end of August.
export function form2290DueForFirstUse(firstUse) {
  if (!isISODate(firstUse)) return null;
  const y = Number(firstUse.slice(0, 4));
  const m = Number(firstUse.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return nextBusinessDay(lastDayOfMonth(ny, nm));
}
export function form2290Dues(firstUse, today) {
  const first = form2290DueForFirstUse(firstUse);
  if (!first) return [];
  const endYear = Number(String(today).slice(0, 4)) + 2;
  const dues = [first];
  for (let y = Number(first.slice(0, 4)); y <= endYear; y++) {
    const aug = nextBusinessDay(lastDayOfMonth(y, 8));
    if (aug > first) dues.push(aug);
  }
  return dues;
}

function reminderHit(reminders, ruleKey, period, truckId = null) {
  return (reminders || []).find((r) => r.rule_key === ruleKey && r.period === period && (r.truck_id || null) === (truckId || null)) || null;
}
function applies(answers, key) {
  return !key || answers?.[key] !== false;
}

// Every computed reminder in a wide window. Dismissed and completed flags come from saved rows.
export function complianceEntries({ today, dot, answers = {}, iftaRenewalOn, irpRenewalOn, hvutFirstUseOn, reminders = [] } = {}) {
  if (!isISODate(today)) return [];
  const out = [];
  const push = (entry) => {
    const hit = reminderHit(reminders, entry.ruleKey, entry.period, entry.truckId || null);
    out.push({
      truckId: null, driverId: null, needs: 'audit', opens: null, ...entry,
      completed: hit?.status === 'completed', dismissed: hit?.status === 'dismissed',
    });
  };

  if (applies(answers, 'interstate')) {
    const y = Number(today.slice(0, 4));
    for (const due of mcs150DueDates(dot, y - 1, y + 2)) {
      if (daysBetween(today, due) < -40 || daysBetween(today, due) > 400) continue;
      push({
        ruleKey: 'mcs150', period: `mcs150-${due.slice(0, 7)}`, due, itemKey: 'usdot_mcs150',
        title: 'MCS-150 update', needs: 'upload',
        detail: `Due ${due}, from the last two digits of the USDOT number. File by the last day of that month.`,
      });
    }
  }

  if (applies(answers, 'ifta_irp')) {
    for (const q of iftaQuartersAround(today)) {
      if (daysBetween(today, q.due) < -45 || daysBetween(today, q.due) > 200) continue;
      push({ ...q, needs: 'audit' });
    }
    if (isISODate(iftaRenewalOn)) {
      push({
        ruleKey: 'ifta_renewal', period: `ifta-renewal-${iftaRenewalOn}`, due: iftaRenewalOn,
        itemKey: 'ifta_license', title: 'IFTA license renewal', needs: 'upload',
        detail: 'The date you entered. Renewal month depends on your base state.',
      });
    } else {
      push({
        ruleKey: 'ifta_renewal', period: 'ifta-renewal-unset', due: today, itemKey: 'ifta_license',
        title: 'Enter your IFTA renewal date', needs: 'date',
        detail: 'Each base state sets this date. Enter yours so it shows on the calendar.',
      });
    }
    if (isISODate(irpRenewalOn)) {
      push({
        ruleKey: 'irp_renewal', period: `irp-renewal-${irpRenewalOn}`, due: irpRenewalOn,
        itemKey: 'irp_account', title: 'IRP renewal', needs: 'upload',
        detail: 'The date you entered. IRP renewal depends on your base state.',
      });
    } else {
      push({
        ruleKey: 'irp_renewal', period: 'irp-renewal-unset', due: today, itemKey: 'irp_account',
        title: 'Enter your IRP renewal date', needs: 'date',
        detail: 'Each base state sets this date. Enter yours so it shows on the calendar.',
      });
    }
  }

  if (applies(answers, 'hvut')) {
    if (isISODate(hvutFirstUseOn)) {
      for (const due of form2290Dues(hvutFirstUseOn, today)) {
        if (daysBetween(today, due) < -90 || daysBetween(today, due) > 400) continue;
        push({
          ruleKey: 'form_2290', period: `2290-${due}`, due, itemKey: 'form_2290',
          title: 'Form 2290 (Heavy Vehicle Use Tax)', needs: 'upload',
          detail: 'Due the last business day of the month after first use. July first use is due at the end of August.',
        });
      }
    } else {
      push({
        ruleKey: 'form_2290', period: '2290-unset', due: today, itemKey: 'form_2290',
        title: 'Enter the first month a taxable vehicle was used', needs: 'date',
        detail: 'Form 2290 is due the last day of the next month. A July first use is due August 31.',
      });
    }
  }

  if (applies(answers, 'interstate')) {
    const ucr = ucrCycle(today);
    const untilOpen = daysBetween(today, ucr.opens);
    if (ucr.open || (untilOpen >= 0 && untilOpen <= 60) || (daysBetween(today, ucr.due) >= -40 && daysBetween(today, ucr.due) <= 0)) {
      push({ ...ucr, needs: 'upload' });
    }
  }

  return out.sort((a, b) => String(a.due).localeCompare(String(b.due)) || a.title.localeCompare(b.title));
}

// Home "Coming up": the next open item per rule, overdue by up to 45 days still shows.
export function comingUp(entries, today, limit = 6) {
  const open = (entries || []).filter((e) => !e.dismissed && !e.completed && isISODate(e.due) && daysBetween(today, e.due) >= -45);
  const seen = new Set();
  const out = [];
  for (const e of open) {
    const k = `${e.ruleKey}:${e.truckId || ''}:${e.driverId || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export function entriesInMonth(entries, year, month) {
  const prefix = iso(year, month, 1).slice(0, 7);
  return (entries || []).filter((e) => isISODate(e.due) && e.due.startsWith(prefix) && !e.dismissed);
}
