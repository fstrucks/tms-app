import { createClient } from '@supabase/supabase-js';
import { runExtraction, RECEIPT_RATE_LIMIT } from '../../lib/ai-extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Reads an expense receipt image and returns suggested form fields. Writes nothing except the
// extraction_runs rate-limit log (claim_extraction_slot, kind 'receipt': its own quota).
// Vercel caps request bodies at 4.5 MB, so the whole multipart body is limited to that.
const MAX_BYTES = 4.5 * 1024 * 1024;
const TOO_LARGE = 'Image is too large to read automatically (max 4.5 MB). Please enter the details manually.';
const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp'];
const GENERIC = "Couldn't read this receipt. Please enter the details manually.";

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, publicMsg, ...log) => {
  if (log.length) console.error('[extract-receipt]', ...log);
  return json({ error: publicMsg }, status);
};

// Trust the bytes, not the client-supplied type.
function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const TOO_BIG = Symbol('too big');
async function readCapped(req, max) {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { reader.cancel().catch(() => {}); return TOO_BIG; }
      chunks.push(value);
    }
  } catch (err) {
    console.error('[extract-receipt] read body', err?.message);
    return null;
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export async function POST(req) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail(501, 'Receipt reading is not configured.', 'OPENAI_API_KEY missing');
  if (!url || !anonKey || !serviceKey) {
    return fail(500, 'Server configuration error.', 'Missing env:', [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', '));
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'Please sign in again.');

  // Size guard before reading anything: require a declared length within the limit.
  const lenHeader = req.headers.get('content-length');
  if (!lenHeader || !/^\d+$/.test(lenHeader)) return fail(411, 'Content-Length is required.');
  if (Number(lenHeader) > MAX_BYTES) return fail(413, TOO_LARGE);

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const userDb = createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: userData, error: userErr } = await userDb.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return fail(401, 'Please sign in again.', userErr?.message);

  // Read the body with a hard cap (don't trust Content-Length alone).
  const body = await readCapped(req, MAX_BYTES);
  if (body === TOO_BIG) return fail(413, TOO_LARGE);
  if (!body) return fail(400, 'Could not read the upload.');

  let file, today;
  try {
    const form = await new Response(body, { headers: { 'content-type': req.headers.get('content-type') || '' } }).formData();
    file = form.get('file');
    today = form.get('today');
  } catch (err) {
    return fail(400, 'Send the receipt image as multipart form field "file".', 'formData', err?.message);
  }
  if (!file || typeof file.arrayBuffer !== 'function') return fail(400, 'Send the receipt image as multipart form field "file".');
  if (file.size > MAX_BYTES) return fail(413, TOO_LARGE);
  if (file.size === 0) return fail(400, 'The image is empty.');

  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffMime(buf);
  if (mime === 'application/pdf') return fail(400, 'PDF receipts can’t be read automatically yet. Please enter the details manually.');
  if (!SUPPORTED.includes(mime)) return fail(415, 'Unsupported image type. Use JPEG, PNG or WebP.', 'sniffed', mime, file.type);

  // Per-user receipt quota, separate from rate-confirmation extraction.
  const admin = createClient(url, serviceKey, opts);
  const { data: runId, error: claimErr } = await admin.rpc('claim_extraction_slot', { p_user: user.id, p_document: null, p_kind: 'receipt' });
  if (claimErr) return fail(500, GENERIC, 'claim slot', claimErr.message);
  if (!runId) return fail(429, `Receipt reading limit reached (${RECEIPT_RATE_LIMIT.perHour}/hour, ${RECEIPT_RATE_LIMIT.perDay}/day). Please enter the details manually.`);
  const finish = (status) => admin.from('extraction_runs').update({ status }).eq('id', runId);

  // The client's local date (YYYY-MM-DD) bounds "not in the future"; fall back to server date.
  const todayOk = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined;
  const result = await runExtraction('receipt', {
    apiKey,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    normalizeOpts: todayOk ? { today: todayOk, todaySlackDays: 0 } : { todaySlackDays: 1 },
  });
  if (result.error) {
    await finish(result.error.timeout ? 'timeout' : 'error');
    return fail(result.error.status || 502, result.error.timeout ? 'Reading the receipt timed out. Please enter the details manually.' : GENERIC, ...(result.error.log || []));
  }
  await finish('success');
  const { _debug, ...data } = result.data;
  // Debug log for date/category issues (no amounts or vendor text).
  console.info('[extract-receipt] read', JSON.stringify({ today: todayOk || null, ..._debug, expense_date: data.expense_date, category: data.category, confidence: data.confidence }));
  return json({ data });
}
