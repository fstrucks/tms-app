import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptDate, DOC_TYPES, RECEIPT_CATEGORIES } from '../../app/lib/ai-extract.js';

const L = '2026-10-12'; // "today" bound
const norm = DOC_TYPES.receipt.normalize;

test('parseReceiptDate: numeric US formats', () => {
  assert.equal(parseReceiptDate('09/26/26', L), '2026-09-26');
  assert.equal(parseReceiptDate('9-26-2026', L), '2026-09-26');
  assert.equal(parseReceiptDate('09.26.26', L), '2026-09-26');
  assert.equal(parseReceiptDate('2026-09-26 14:22', L), '2026-09-26');
  assert.equal(parseReceiptDate('10/03/26 14:22', L), '2026-10-03');
});
test('parseReceiptDate: word months', () => {
  assert.equal(parseReceiptDate('Oct 3, 2026', L), '2026-10-03');
  assert.equal(parseReceiptDate('Sept 26', L), '2026-09-26');
  assert.equal(parseReceiptDate('26 September 2026', L), '2026-09-26');
  assert.equal(parseReceiptDate('Sat, Oct 3rd, 2026', L), '2026-10-03');
});
test('parseReceiptDate: yearless -> most recent past occurrence', () => {
  assert.equal(parseReceiptDate('10/12', L), '2026-10-12');
  assert.equal(parseReceiptDate('12/25', L), '2025-12-25');
});
test('parseReceiptDate: rejects future, impossible, pre-2000, junk', () => {
  assert.equal(parseReceiptDate('10/13/26', L), null);
  assert.equal(parseReceiptDate('02/30/26', L), null);
  assert.equal(parseReceiptDate('13/01/26', L), null);
  assert.equal(parseReceiptDate('01/01/1999', L), null);
  assert.equal(parseReceiptDate('no date here', L), null);
  assert.equal(parseReceiptDate(null, L), null);
  assert.equal(parseReceiptDate('2/29/2024', L), '2024-02-29');
});
test('parseReceiptDate: skips card expiry, prefers dated candidates', () => {
  assert.equal(parseReceiptDate('Exp 12/30 Date 09/26/26', L), '2026-09-26');
  assert.equal(parseReceiptDate('Valid thru 01/29 Sep 26 2026', L), '2026-09-26');
  assert.equal(parseReceiptDate('9/20 09/26/2026', L), '2026-09-26');
});
test('parseReceiptDate: substrings like "mayo"/"decal" are not months', () => {
  assert.equal(parseReceiptDate('mayo 5', L), null);
  assert.equal(parseReceiptDate('decal 3', L), null);
});
test('parseReceiptDate: a price is not a date ', () => {
  // "$3.15" reads as March 15 if the model ever puts a price in date_raw.
  assert.equal(parseReceiptDate('Total $3.15', L), null);
});

test('normalize: date from date_raw only; never today', () => {
  assert.equal(norm({ date_raw: '09/26/26' }, { today: L }).expense_date, '2026-09-26');
  assert.equal(norm({ date_raw: null, expense_date: L }, { today: L }).expense_date, null);
  assert.equal(norm({ date_raw: 'smudged', expense_date: '2026-09-01' }, { today: L }).expense_date, '2026-09-01');
  assert.equal(norm({ date_raw: 'smudged', expense_date: '2026-11-01' }, { today: L }).expense_date, null);
  // server fallback slack of 1 day allows tomorrow
  assert.equal(norm({ date_raw: '10/13/26' }, { today: L, todaySlackDays: 1 }).expense_date, '2026-10-13');
});
test('normalize: category only if allowlisted and confident', () => {
  for (const c of RECEIPT_CATEGORIES) assert.equal(norm({ category: c, category_confident: true }, { today: L }).category, c);
  assert.equal(norm({ category: ' Fuel ', category_confident: true }, { today: L }).category, 'fuel');
  assert.equal(norm({ category: 'fuel', category_confident: false }, { today: L }).category, null);
  assert.equal(norm({ category: 'fuel' }, { today: L }).category, null);
  assert.equal(norm({ category: 'parking', category_confident: true }, { today: L }).category, null);
});
test('normalize: amount + not-a-receipt', () => {
  assert.equal(norm({ amount: '$1,234.567' }, { today: L }).amount, 1234.57);
  assert.equal(norm({ amount: -5 }, { today: L }).amount, null);
  const n = norm({ is_receipt: false, amount: 5, category: 'fuel', category_confident: true, date_raw: '09/26/26' }, { today: L });
  assert.deepEqual([n.amount, n.category, n.expense_date, n.confidence], [null, null, null, 0]);
});
