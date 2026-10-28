// Browser-safe copy and helpers for the company export (shared by the Danger zone panel, the link page and the email).
export const MANY_PARTS_NOTE = 'Big accounts arrive as many parts. Download each one; together they make the full copy.';

// GET /api/company-export polling: every 5 s for the first minute, then every 15 s; stop when not open.
export const OPEN_STATUSES = ['queued', 'running'];
export function pollDelayMs(elapsedMs) { return elapsedMs < 60_000 ? 5_000 : 15_000; }
export const shouldPoll = (job) => !!job && OPEN_STATUSES.includes(job.status);

export function statusLine(job) {
  if (!job) return null;
  const n = job.partCount || 0;
  const parts = `${n} ${n === 1 ? 'part' : 'parts'}`;
  switch (job.status) {
    case 'queued': return 'Export queued. It starts in a moment.';
    case 'running': return n ? `Building the export… ${parts} finished so far.` : 'Building the export…';
    case 'ready': return `Export ready: ${parts}. ${MANY_PARTS_NOTE}`;
    case 'failed': return 'The last export failed. Start a new one.';
    case 'expired': return 'The last export has expired. Start a new one to get a fresh copy.';
    default: return null;
  }
}

// Error text for a failed POST/GET. Uses the server message when there is one.
export function exportErrorText(res, body) {
  if (res.status === 429) return body?.error || 'You can start up to 3 exports a day. Try again tomorrow.';
  if (body?.code === 'storage_budget') return body.error || 'Exports are busy right now. Try again later.';
  return body?.error || 'Couldn’t start the export. Try again.';
}
