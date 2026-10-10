import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_MODEL = 'gpt-4o-mini';
const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];
const MAX_BYTES = 10 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 50_000;
const LIMIT_PER_HOUR = 20;
const LIMIT_PER_DAY = 100;
const GENERIC = 'Extraction failed, please try again.';

// Only these are sent to OpenAI. Anything else gets a 415.
const SUPPORTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

const str = { type: ['string', 'null'] };
const party = { type: ['object', 'null'], additionalProperties: false, required: ['name', 'address'], properties: { name: str, address: str } };
const stop = { type: ['object', 'null'], additionalProperties: false, required: ['date', 'time', 'address'], properties: { date: str, time: str, address: str } };
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['broker_name', 'load_number', 'reference_numbers', 'shipper', 'receiver', 'pickup', 'delivery', 'rate', 'notes'],
  properties: {
    broker_name: str,
    load_number: str,
    reference_numbers: { type: ['array', 'null'], items: { type: 'string' } },
    shipper: party,
    receiver: party,
    pickup: stop,
    delivery: stop,
    rate: { type: ['number', 'null'], description: 'Total linehaul/all-in rate in USD' },
    notes: str,
  },
};

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, publicMsg, ...log) => {
  if (log.length) console.error('[extract]', ...log);
  return json({ error: publicMsg }, status);
};

function resolveMime(blobType, name) {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return EXT_TYPES[ext] || null;
}

export async function POST(req) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail(501, 'AI extraction is not configured.', 'OPENAI_API_KEY missing');
  if (!url || !anonKey || !serviceKey) {
    return fail(500, 'Server configuration error.', 'Missing env:', [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', '));
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'Please sign in again.');

  let documentId, force = false;
  try { ({ documentId, force = false } = await req.json()); } catch {}
  if (!documentId) return fail(400, 'documentId is required.');

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  // User-scoped client: RLS applies, used to verify identity and ownership.
  const userDb = createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: userData, error: userErr } = await userDb.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return fail(401, 'Please sign in again.', userErr?.message);

  const { data: doc, error: docErr } = await userDb
    .from('documents').select('id, user_id, file_path, original_filename, ai_extracted_data').eq('id', documentId).maybeSingle();
  if (docErr) return fail(500, GENERIC, 'doc load', docErr.message);
  if (!doc || doc.user_id !== user.id) return fail(404, 'Document not found.');

  if (doc.ai_extracted_data && force !== true) {
    return json({ error: 'Already extracted. Re-run to overwrite.', data: doc.ai_extracted_data }, 409);
  }

  // Service client: only after ownership is verified. Used for extraction_runs + ai_extracted_data.
  const admin = createClient(url, serviceKey, opts);

  const now = Date.now();
  const hourAgo = new Date(now - 3600_000).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const [h, d] = await Promise.all([
    admin.from('extraction_runs').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', hourAgo),
    admin.from('extraction_runs').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', dayAgo),
  ]);
  if (h.error || d.error) return fail(500, GENERIC, 'rate limit query', h.error?.message || d.error?.message);
  if (h.count >= LIMIT_PER_HOUR || d.count >= LIMIT_PER_DAY) {
    return fail(429, `Extraction limit reached (${LIMIT_PER_HOUR}/hour, ${LIMIT_PER_DAY}/day). Try again later.`);
  }

  const name = doc.original_filename || doc.file_path;
  const slash = doc.file_path.lastIndexOf('/');
  const { data: objs } = await admin.storage.from('documents').list(doc.file_path.slice(0, slash), {
    search: doc.file_path.slice(slash + 1), limit: 1,
  });
  const meta = objs?.[0]?.metadata;
  if (meta?.size > MAX_BYTES) return fail(413, 'File is too large to extract (max 10 MB).');

  const preMime = resolveMime(meta?.mimetype, doc.file_path) || resolveMime(null, name);
  if (preMime === 'image/heic' || preMime === 'image/heif') {
    return fail(415, 'HEIC/HEIF photos cannot be extracted directly. Re-upload it here (photos are converted to JPEG automatically) or upload a JPEG, PNG, WebP or PDF.');
  }
  if (preMime && !SUPPORTED.includes(preMime)) return fail(415, 'Unsupported file type. Use PDF, JPEG, PNG or WebP.');

  const { data: run, error: runErr } = await admin.from('extraction_runs')
    .insert({ user_id: user.id, document_id: doc.id, status: 'started' }).select('id').single();
  if (runErr) return fail(500, GENERIC, 'run insert', runErr.message);
  const finish = (status) => admin.from('extraction_runs').update({ status }).eq('id', run.id);

  const { data: blob, error: dlErr } = await userDb.storage.from('documents').download(doc.file_path);
  if (dlErr || !blob) { await finish('error'); return fail(500, GENERIC, 'download', dlErr?.message); }
  if (blob.size > MAX_BYTES) { await finish('rejected'); return fail(413, 'File is too large to extract (max 10 MB).'); }

  const mime = resolveMime(blob.type, doc.file_path) || preMime;
  if (mime === 'image/heic' || mime === 'image/heif') {
    await finish('rejected');
    return fail(415, 'HEIC/HEIF photos cannot be extracted directly. Re-upload it here (photos are converted to JPEG automatically) or upload a JPEG, PNG, WebP or PDF.');
  }
  if (!SUPPORTED.includes(mime)) { await finish('rejected'); return fail(415, 'Unsupported file type. Use PDF, JPEG, PNG or WebP.'); }

  const dataUrl = `data:${mime};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
  const filePart = mime === 'application/pdf'
    ? { type: 'input_file', filename: name, file_data: dataUrl }
    : { type: 'input_image', image_url: dataUrl };
  const model = ALLOWED_MODELS.includes(process.env.OPENAI_MODEL) ? process.env.OPENAI_MODEL : DEFAULT_MODEL;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
  let aiRes, aiBody;
  try {
    aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_output_tokens: 1500,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract the load details from this trucking rate confirmation. Use null for anything not present. Dates as YYYY-MM-DD when possible. rate is the total carrier pay in USD as a number.' },
            filePart,
          ],
        }],
        text: { format: { type: 'json_schema', name: 'rate_confirmation', strict: true, schema } },
      }),
    });
    aiBody = await aiRes.json().catch(() => ({}));
  } catch (err) {
    await finish(err.name === 'AbortError' ? 'timeout' : 'error');
    if (err.name === 'AbortError') return fail(504, 'Extraction timed out, please try again.', 'OpenAI timeout');
    return fail(502, GENERIC, 'OpenAI fetch', err.message);
  } finally {
    clearTimeout(timer);
  }
  if (!aiRes.ok) { await finish('error'); return fail(502, GENERIC, 'OpenAI', aiRes.status, aiBody?.error?.message); }

  const text = aiBody.output_text
    ?? aiBody.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text;
  let extracted;
  try { extracted = JSON.parse(text); } catch { await finish('error'); return fail(502, GENERIC, 'parse', aiBody?.status, aiBody?.incomplete_details); }

  const { error: upErr } = await admin.from('documents').update({ ai_extracted_data: extracted })
    .eq('id', doc.id).eq('user_id', user.id);
  if (upErr) { await finish('error'); return fail(500, GENERIC, 'save', upErr.message); }

  await finish('success');
  return json({ data: extracted });
}
