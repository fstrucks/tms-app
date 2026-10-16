// One user-facing label per packet status, shared by the /packets list and the packet page.
export const PACKET_STATUS_LABELS = {
  received: 'Waiting to start',
  processing: 'Finding fields…',
  review: 'Ready to fill out',
  error: 'Needs attention',
};
export const packetStatusLabel = (status) => PACKET_STATUS_LABELS[status] || String(status || '');
export const isPendingStatus = (status) => status === 'received' || status === 'processing';
// List polling: fast while anything is pending, stop when nothing is (or after the cap).
export const POLL_MS = 2000;
export const POLL_MAX_TICKS = 90; // ~3 min
