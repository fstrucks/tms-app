// Client-safe helpers for Send to broker (no Node APIs).
// One idempotency key per send attempt; the server uses it as the packet_sends row id.
export const newSendKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (Math.random() * 16 >> (c / 4))).toString(16)));

// After a send call fails without a clear answer (network drop, timeout), look at the history for THIS attempt's
// key before telling the user anything. → 'sent' | 'unknown' | 'not-sent'
export function attemptOutcome(sends, key) {
  const row = (sends || []).find((s) => s.id === key);
  if (!row) return 'not-sent';
  return row.confirmed || row.postmark_message_id ? 'sent' : 'unknown';
}

// Case-insensitive de-dupe, keeping the first-seen order (and spelling). Taylor nit: "Not allowed:" listed an address twice.
export function uniqueEmails(list) {
  const seen = new Set();
  return (list || []).map((e) => String(e || '').trim()).filter((e) => {
    const k = e.toLowerCase();
    if (!e || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Addresses in To + CC outside the allowed domains (null domains = no limit), de-duplicated.
export function outsideRecipients(to, cc, domains) {
  if (!domains) return [];
  const split = (s) => String(s || '').split(/[,;\s]+/).filter(Boolean);
  const allowed = domains.map((d) => String(d).toLowerCase());
  return uniqueEmails([...split(to), ...split(cc)]).filter((e) => !allowed.includes(String(e.split('@')[1] || '').toLowerCase()));
}

// Primary button style that clearly looks disabled (grey, faded, not-allowed cursor) instead of staying blue.
export function primaryButtonStyle(base, disabled) {
  return disabled ? { ...base, background: 'var(--disabled-bg)', color: 'var(--disabled-text)', cursor: 'not-allowed' } : { ...base, cursor: 'pointer' };
}

// Automatic copy (PACKET_CC_EMAIL, default marc@fstrucks.com): the address to CC, or null when it's off or already
// one of the To addresses (case-insensitive; no duplicate copy to someone already receiving it).
export function autoCcFor(autoCc, to = []) {
  const a = String(autoCc || '').trim().toLowerCase();
  if (!a) return null;
  return (to || []).some((e) => String(e || '').trim().toLowerCase() === a) ? null : a;
}
