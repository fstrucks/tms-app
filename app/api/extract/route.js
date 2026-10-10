import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function POST(req) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ error: 'AI extraction is not configured (OPENAI_API_KEY missing).' }, 501);

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return json({ error: 'Supabase is not configured on the server (missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).' }, 500);
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Unauthorized: missing access token.' }, 401);

  let documentId;
  try { ({ documentId } = await req.json()); } catch {}
  if (!documentId) return json({ error: 'documentId is required.' }, 400);

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'Unauthorized: invalid or expired session.' }, 401);

  const { data: doc, error: docErr } = await supabase
    .from('documents').select('id, file_path, original_filename').eq('id', documentId).single();
  if (docErr || !doc) return json({ error: 'Document not found.' }, 404);

  const { data: blob, error: dlErr } = await supabase.storage.from('documents').download(doc.file_path);
  if (dlErr || !blob) return json({ error: 'Could not download file: ' + (dlErr?.message || 'unknown') }, 500);

  const buf = Buffer.from(await blob.arrayBuffer());
  const name = doc.original_filename || 'document';
  const mime = blob.type && blob.type !== 'application/octet-stream'
    ? blob.type
    : /\.pdf$/i.test(name) ? 'application/pdf' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const filePart = mime === 'application/pdf'
    ? { type: 'input_file', filename: name, file_data: dataUrl }
    : { type: 'input_image', image_url: dataUrl };

  const aiRes = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
  const aiBody = await aiRes.json().catch(() => ({}));
  if (!aiRes.ok) return json({ error: 'OpenAI error: ' + (aiBody?.error?.message || aiRes.status) }, 502);

  const text = aiBody.output_text
    ?? aiBody.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text;
  let extracted;
  try { extracted = JSON.parse(text); } catch { return json({ error: 'Could not parse AI response.' }, 502); }

  const { error: upErr } = await supabase.from('documents').update({ ai_extracted_data: extracted }).eq('id', doc.id);
  if (upErr) return json({ error: 'Extracted but could not save: ' + upErr.message, data: extracted }, 500);

  return json({ data: extracted });
}
