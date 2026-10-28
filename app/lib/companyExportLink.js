// Export link (E3): token minting, the no-sign-in /export/<token> page data, per-part signed URLs,
// link events, and the owner email. Only sha256(token) is stored (export_jobs.token_hash).
import { createHmac, randomUUID } from 'node:crypto';
import { EXPORT_BUCKET, COUNTS_TOWARD_SEND_CAP, PART_MAX_BYTES, hashToken, newLinkToken, tokenMatches } from './companyExport.js';
import { senderConfig, postmarkSend } from './packetSend.js';

export const SIGNED_URL_SECONDS = 300;
export const MINTS_PER_JOB_PER_HOUR = 120;
export const HITS_PER_IP_PER_10_MIN = 40;
export const MAIL_MAX_ATTEMPTS = 3;
export const MAIL_LEASE_MS = 120_000;
export { COUNTS_TOWARD_SEND_CAP };

export const tokenShapeOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

export function linkBaseUrl(env = process.env) {
  const raw = String(env.EXPORT_LINK_BASE_URL || env.APP_BASE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).trim().replace(/\/+$/, '');
  return /^https:\/\/[^/\s]+$/.test(raw) ? raw : null;
}
export const linkUrl = (token, env = process.env) => { const b = linkBaseUrl(env); return b ? `${b}/export/${token}` : null; };

// Hash of the client IP keyed with a server secret, so the raw IP is never stored. Null when no secret is set.
export function ipHash(ip, env = process.env) {
  const key = String(env.EXPORT_LINK_SECRET || env.CRON_SECRET || '');
  if (!key || !ip) return null;
  return createHmac('sha256', key).update(String(ip)).digest('hex');
}
export function clientIp(headers) {
  const xf = headers?.get?.('x-forwarded-for') || '';
  return (xf.split(',')[0] || headers?.get?.('x-real-ip') || '').trim() || null;
}
export const partFileName = (n, count) => `powerhaul-export-part-${String(n).padStart(String(count).length, '0')}-of-${count}.zip`;

// Per-instance limiter for page hits by IP hash (covers unknown tokens, which have no job to log against).
const hits = new Map();
export function ipLimited(key, now = Date.now(), limit = HITS_PER_IP_PER_10_MIN) {
  if (!key) return false;
  const win = 10 * 60_000;
  const h = (hits.get(key) || []).filter((t) => now - t < win);
  h.push(now); hits.set(key, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < win)) hits.delete(k);
  return h.length > limit;
}
export const _resetLimiter = () => hits.clear();

export async function logEvent(admin, jobId, kind, { ip = null, userAgent = null, env = process.env, now = new Date() } = {}) {
  const r = await admin.from('export_link_events').insert({ job_id: jobId, kind, at: now.toISOString(), ip_hash: ipHash(ip, env), user_agent: userAgent ? String(userAgent).slice(0, 300) : null });
  if (r?.error) console.error('[company-export] event', kind, r.error.code || r.error.message);
}

// Mints a new link for a ready job and stores only its hash. Replaces any earlier link.
export async function issueLink(admin, job, { now = new Date(), env = process.env } = {}) {
  if (!job || job.status !== 'ready' || job.cleaned_at || !job.expires_at || Date.parse(job.expires_at) <= +now) return { ok: false, code: 'not_ready' };
  const { token, hash } = newLinkToken();
  const r = await admin.from('export_jobs').update({ token_hash: hash }).eq('id', job.id).eq('status', 'ready').is('cleaned_at', null).select('id').maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) return { ok: false, code: 'not_ready' };
  return { ok: true, token, url: linkUrl(token, env) };
}

// Looks a token up by its hash. Unknown, malformed, expired and cleaned all look the same to the caller (404).
export async function findByToken(admin, token, now = new Date()) {
  if (!tokenShapeOk(token)) return { found: false };
  const h = hashToken(token);
  const r = await admin.from('export_jobs').select('*').eq('token_hash', h).maybeSingle();
  if (r.error || !r.data || !tokenMatches(token, r.data.token_hash)) return { found: false };
  const j = r.data;
  const live = j.status === 'ready' && !j.cleaned_at && j.expires_at && Date.parse(j.expires_at) > +now;
  return live ? { found: true, job: j } : { found: false, expiredJob: j };
}

export function pageView(job) {
  const parts = (Array.isArray(job.parts) ? job.parts : []).slice().sort((a, b) => a.n - b.n);
  return {
    expiresAt: job.expires_at, partCount: parts.length, partMaxBytes: PART_MAX_BYTES,
    totalBytes: parts.reduce((s, p) => s + (p.bytes || 0), 0), fileCount: job.file_count || 0, missingCount: job.missing_count || 0,
    deletion: job.trigger === 'deletion', purgeAt: job.purge_at || null,
    parts: parts.map((p) => ({ n: p.n, name: partFileName(p.n, parts.length), bytes: p.bytes || 0 })),
  };
}

const NOT_FOUND = { status: 404 };
export async function exportLinkPage(admin, token, { headers, now = new Date(), env = process.env } = {}) {
  const ip = clientIp(headers); const ua = headers?.get?.('user-agent') || null;
  if (ipLimited(ipHash(ip, env) || ip, +now)) return { status: 429 };
  const f = await findByToken(admin, token, now);
  if (!f.found) { if (f.expiredJob) await logEvent(admin, f.expiredJob.id, 'expired_hit', { ip, userAgent: ua, env, now }); return NOT_FOUND; }
  await logEvent(admin, f.job.id, 'link_opened', { ip, userAgent: ua, env, now });
  return { status: 200, view: pageView(f.job) };
}

// Signed URL for one part, minted server-side for a few minutes, with a download file name.
export async function exportPartUrl(admin, token, n, { headers, now = new Date(), env = process.env } = {}) {
  const ip = clientIp(headers); const ua = headers?.get?.('user-agent') || null;
  if (ipLimited(ipHash(ip, env) || ip, +now)) return { status: 429 };
  const f = await findByToken(admin, token, now);
  if (!f.found) { if (f.expiredJob) await logEvent(admin, f.expiredJob.id, 'expired_hit', { ip, userAgent: ua, env, now }); return NOT_FOUND; }
  const parts = Array.isArray(f.job.parts) ? f.job.parts : [];
  const part = parts.find((p) => p.n === Number(n));
  if (!part || !/^\d+$/.test(String(n))) return NOT_FOUND;
  const since = new Date(+now - 3600_000).toISOString();
  const used = await admin.from('export_link_events').select('id').eq('job_id', f.job.id).eq('kind', 'url_minted').gte('at', since);
  if (!used.error && (used.data || []).length >= MINTS_PER_JOB_PER_HOUR) return { status: 429 };
  const s = await admin.storage.from(EXPORT_BUCKET).createSignedUrl(part.object, SIGNED_URL_SECONDS, { download: partFileName(part.n, parts.length) });
  if (s.error || !s.data?.signedUrl) return { status: 503 };
  await logEvent(admin, f.job.id, 'url_minted', { ip, userAgent: ua, env, now });
  return { status: 302, location: s.data.signedUrl };
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
export const fmtBytes = (b) => (b >= 1024 * 1024 * 1024 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 * 1024 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export const RETENTION_NOTE = 'Keep this copy somewhere safe. Carriers often have to keep records for years: FMCSA rules call for keeping many records from 6 months to 5 years, and the IRS generally expects tax records for 3 to 7 years. Deleting your account permanently removes your data from PowerHaul TMS, and it cannot be recovered after that.';
export const MANY_PARTS_NOTE = 'Big accounts arrive as many parts. Download each one; together they make the full copy.';

export function exportEmail({ url, expiresAt, partCount, totalBytes, deletion }) {
  const subject = 'Your PowerHaul TMS company export is ready';
  const body = [
    'Hi,',
    '',
    `Your company export from PowerHaul TMS is ready. It is a copy of your company records (loads, invoices, expenses, maintenance and more as CSV and JSON files) and your uploaded documents.`,
    '',
    `Download it here (no sign-in needed): ${url}`,
    '',
    `It has ${partCount} ${partCount === 1 ? 'part' : 'parts'} (${fmtBytes(totalBytes)} in total). ${MANY_PARTS_NOTE}`,
    `The link works until ${fmtDate(expiresAt)}.${deletion ? ' Your account is scheduled for deletion, so download it before then.' : ''}`,
    '',
    RETENTION_NOTE,
    '',
    'Anyone with this link can download the export, so do not forward it. If you did not ask for this, contact support.',
    '',
    'PowerHaul TMS',
  ].join('\n');
  return { subject, body };
}

// Sends the link email once per job. A short lease in cursor.lease keeps two senders apart.
// Export emails are not packet sends and do not count toward the monthly send cap (no send-cap row is written).
export async function deliverExport(admin, jobId, { now = new Date(), env = process.env, send = postmarkSend, fetchImpl } = {}) {
  const got = await admin.from('export_jobs').select('*').eq('id', jobId).maybeSingle();
  if (got.error) throw got.error;
  const job = got.data;
  if (!job || job.status !== 'ready' || job.cleaned_at || !job.deliver_to) return { ok: false, code: 'not_ready' };
  const c = job.cursor || {};
  if (c.mail_sent_at || c.mail_unknown) return { ok: true, already: true };
  if ((c.mail_attempts || 0) >= MAIL_MAX_ATTEMPTS) return { ok: false, code: 'mail_gave_up' };
  if (c.lease && c.lease_until && Date.parse(c.lease_until) > +now) return { ok: true, busy: true };
  const cfg = senderConfig(env);
  if (!cfg.token) return { ok: false, code: 'mail_not_configured' };
  if (!linkBaseUrl(env)) return { ok: false, code: 'no_base_url' };
  const lease = randomUUID();
  const claim = await admin.from('export_jobs').update({ cursor: { ...c, lease, lease_until: new Date(+now + MAIL_LEASE_MS).toISOString() } })
    .eq('id', job.id).eq('cursor->>lease', c.lease || '').select('id').maybeSingle();
  if (claim.error) throw claim.error;
  if (!claim.data) return { ok: true, busy: true };
  const done = async (patch) => admin.from('export_jobs').update({ cursor: { ...c, lease: '', lease_until: null, ...patch } }).eq('id', job.id).eq('cursor->>lease', lease);
  const link = await issueLink(admin, job, { now, env });
  if (!link.ok) { await done({}); return link; }
  const parts = Array.isArray(job.parts) ? job.parts : [];
  const mail = exportEmail({ url: link.url, expiresAt: job.expires_at, partCount: parts.length, totalBytes: parts.reduce((s, p) => s + (p.bytes || 0), 0), deletion: job.trigger === 'deletion' });
  const res = await send({ token: cfg.token, from: cfg.from, replyTo: cfg.replyTo, stream: cfg.stream, to: [job.deliver_to], cc: [], subject: mail.subject, body: mail.body }, ...(fetchImpl ? [fetchImpl] : []));
  if (res?.error && !res.unknown) {
    await admin.from('export_jobs').update({ token_hash: null }).eq('id', job.id).eq('token_hash', hashToken(link.token)); // unsent link is dropped
    await done({ mail_attempts: (c.mail_attempts || 0) + 1, mail_error: String(res.code ?? 'refused').slice(0, 40) });
    return { ok: false, code: 'mail_failed' };
  }
  if (res?.unknown) { await done({ mail_unknown: now.toISOString() }); return { ok: false, code: 'mail_unknown' }; }
  await done({ mail_sent_at: now.toISOString() });
  await logEvent(admin, job.id, 'email_sent', { env, now });
  return { ok: true, sent: true };
}
