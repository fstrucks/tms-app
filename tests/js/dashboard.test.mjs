import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsAsRevenue, aggregate, summarize, loadDate, weekStart, r2 } from '../../app/lib/dashboard.js';

const wk = (y, m, d) => { const start = new Date(y, m - 1, d); const end = new Date(y, m - 1, d + 7); return { start, end, key: `${y}-${m}-${d}` }; };
const W1 = wk(2026, 9, 14), W2 = wk(2026, 9, 21); // Mondays
const stop = (iso, sequence) => ({ appointment_start: iso, sequence });
const load = (status, rate, total_miles, iso = '2026-09-16T15:00:00') => ({ status, rate, total_miles, stops: [stop(iso, 1)] });

test('countsAsRevenue: delivered/invoiced/paid only', () => {
  for (const s of ['delivered', 'invoiced', 'paid', ' Delivered ', 'PAID']) assert.equal(countsAsRevenue(s), true, s);
  for (const s of ['booked', 'dispatched', 'in_transit', 'cancelled', 'canceled', 'tonu', 'void', '', null, undefined]) assert.equal(countsAsRevenue(s), false, String(s));
});

test('aggregate: revenue from delivered loads only', () => {
  const [w] = aggregate([W1], { loads: [load('delivered', 1000, 400), load('booked', 5000, 1000), load('cancelled', 900, 300), load('paid', 500, 0)], entries: [], expenses: [] });
  assert.equal(w.revenue, 1500);
  assert.equal(w.loads, 2);
  assert.equal(w.loadedRpm, 2.5); // only the load with miles: 1000/400
});

test('aggregate: missing rate counted, not revenue; rate "0" is a rate', () => {
  const [w] = aggregate([W1], { loads: [load('delivered', null, 100), load('delivered', '', 100), load('delivered', '0', 100)], entries: [], expenses: [] });
  assert.deepEqual([w.loads, w.missingRate, w.revenue, w.loadedRpm], [3, 2, 0, 0]);
});

test('aggregate: all-in RPM uses logged loaded+deadhead miles, not personal', () => {
  const entries = [
    { entry_date: '2026-09-15', miles: 300, source: 'loaded' },
    { entry_date: '2026-09-16', miles: 100, source: 'deadhead' },
    { entry_date: '2026-09-16', miles: 50, source: 'personal' },
    { entry_date: '2026-09-17', miles: 10, source: 'weird' },
    { entry_date: '2026-09-17', miles: -5, source: 'loaded' },
  ];
  const [w] = aggregate([W1], { loads: [load('delivered', 1000, 500)], entries, expenses: [] });
  assert.deepEqual(w.miles, { loaded: 300, deadhead: 100, personal: 50, other: 10 });
  assert.equal(w.totalMiles, 460);
  assert.equal(w.allInRpm, 2.5);
  assert.equal(w.loadedRpm, 2);
});

test('aggregate: RPM null with no miles', () => {
  const [w] = aggregate([W1], { loads: [load('delivered', 1000, null)], entries: [], expenses: [] });
  assert.equal(w.loadedRpm, null); assert.equal(w.allInRpm, null);
});

test('aggregate: expenses, net, unknown category kept, cents rounding', () => {
  const expenses = [
    { expense_date: '2026-09-15', amount: '100.10', category: 'fuel' },
    { expense_date: '2026-09-15', amount: 0.2, category: 'fuel' },
    { expense_date: '2026-09-16', amount: 50, category: 'scales' },
    { expense_date: '2026-09-16', amount: 5, category: null },
  ];
  const [w] = aggregate([W1], { loads: [load('delivered', 1000.1, 0)], entries: [], expenses });
  assert.equal(w.expenses.fuel, 100.3);
  assert.equal(w.expenses.scales, 50);
  assert.equal(w.expenses.other, 5);
  assert.equal(w.expenseTotal, 155.3);
  assert.equal(w.net, 844.8);
});

test('aggregate: week bucketing uses delivery (last stop) appointment', () => {
  const l = { status: 'delivered', rate: 800, total_miles: 400, stops: [stop('2026-09-27T10:00:00', 2), stop('2026-09-19T08:00:00', 1)] };
  const [a, b] = aggregate([W1, W2], { loads: [l], entries: [], expenses: [] });
  assert.equal(a.revenue, 0); assert.equal(b.revenue, 800);
  assert.equal(loadDate({ stops: [], created_at: '2026-09-01T00:00:00Z' }).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(loadDate({ stops: [] }), null);
});

test('summarize: totals and RPM recomputed from sums (not averaged)', () => {
  const rows = aggregate([W1, W2], {
    loads: [load('delivered', 1000, 500), load('invoiced', 300, 100, '2026-09-23T12:00:00')],
    entries: [], expenses: [{ expense_date: '2026-09-22', amount: 100, category: 'tolls' }],
  });
  const s = summarize(rows);
  assert.equal(s.revenue, 1300); assert.equal(s.loads, 2);
  assert.equal(s.loadedRpm, r2(1300 / 600)); // 2.17, not avg(2, 3)=2.5
  assert.equal(s.net, 1200);
  assert.equal(summarize([]), null);
});

test('weekStart is Monday', () => {
  assert.equal(weekStart(new Date(2026, 9, 11)).getDate(), 5); // Sun Oct 11 -> Mon Oct 5
  assert.equal(weekStart(new Date(2026, 9, 12)).getDate(), 12);
});

test('non-numeric rate should not count as a $0 rate', () => {
  // Number("abc") -> NaN -> 0 but load is not flagged missingRate.
  const [w] = aggregate([W1], { loads: [load('delivered', 'abc', 100)], entries: [], expenses: [] });
  assert.equal(w.missingRate, 1);
});
