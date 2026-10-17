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
