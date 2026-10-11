// One money formatter for the whole app: en-US USD, always exactly 2 decimals ($389.90).
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const has = (v) => v !== null && v !== undefined && v !== '';

export const fmtMoney = (n) => (has(n) && isFinite(Number(n)) ? USD.format(Number(n)) : '—');

// Per-mile rate, e.g. "$2.56/mi".
export const fmtPerMile = (n) => (has(n) && isFinite(Number(n)) ? `${USD.format(Number(n))}/mi` : '—');

// Value for a money <input> ("389.90"); '' when empty.
export const moneyInput = (n) => (has(n) && isFinite(Number(n)) ? Number(n).toFixed(2) : '');
