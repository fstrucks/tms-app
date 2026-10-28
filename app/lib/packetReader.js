// The ONLY place OpenAI is called for packets. Server-only.
// Local field detection places fields; this names them (gpt-4.1-mini) and checks value formats.
// No key → enabled:false and callers skip naming. Tests inject `transport`; never real calls in tests.
// Never send TIN/ACH/signature values here: only labels, positions and field kinds.
export const READER_MODEL = 'gpt-4.1-mini';
export const PROFILE_KEYS = ['legal_name', 'dba_name', 'mc_number', 'dot_number', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'phone', 'email', 'signer_name', 'signer_title', 'ein', 'bank_routing', 'bank_account', 'signature', 'date', 'unknown'];
export const CONFIRM_KEYS = new Set(['bank_routing', 'bank_account']); // user always confirms these

async function openaiTransport({ apiKey, body, fetchImpl = fetch }) {
  const r = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`reader http ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices?.[0]?.message?.content || '{}');
}

export function createPacketReader({ apiKey = process.env.OPENAI_API_KEY, transport = openaiTransport, model = READER_MODEL } = {}) {
  const enabled = !!(apiKey && String(apiKey).trim());
  return {
    enabled,
    model,
    // fields: [{ id, page, label, kind, box }] from local detection.
    async nameFields(fields) {
      if (!enabled) return { skipped: true, reason: 'OPENAI_API_KEY not set', fields: fields.map((f) => ({ ...f, profile_key: null, confidence: 0, needs_confirm: false })) };
      const clean = fields.map(({ id, page, label, kind, box }) => ({ id, page, label: String(label || '').slice(0, 200), kind, box }));
      const body = {
        model, temperature: 0, store: false, // don't keep the request/response on OpenAI's side
        response_format: { type: 'json_schema', json_schema: { name: 'fields', strict: true, schema: {
          type: 'object', additionalProperties: false, required: ['fields'],
          properties: { fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'profile_key', 'confidence'],
            properties: { id: { type: 'string' }, profile_key: { type: 'string', enum: PROFILE_KEYS }, confidence: { type: 'number' } } } } } } } },
        messages: [
          { role: 'system', content: 'Map carrier packet form labels to profile keys. Use "unknown" when unsure. Return JSON only.' },
          { role: 'user', content: JSON.stringify(clean) },
        ],
      };
      const out = await transport({ apiKey, body });
      const byId = new Map((out?.fields || []).map((x) => [String(x.id), x]));
      return {
        skipped: false,
        fields: fields.map((f) => {
          const m = byId.get(String(f.id));
          const key = m && PROFILE_KEYS.includes(m.profile_key) ? m.profile_key : null;
          return { ...f, profile_key: key === 'unknown' ? null : key, confidence: Math.max(0, Math.min(1, Number(m?.confidence) || 0)), needs_confirm: CONFIRM_KEYS.has(key) };
        }),
      };
    },
  };
}
