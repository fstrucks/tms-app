// Every OpenAI request asks OpenAI not to store it (store: false). Fake key, fake transport: never a real call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runExtraction, DOC_TYPES } from '../../app/lib/ai-extract.js';
import { callRateConModel } from '../../app/lib/rateconExtract.js';
import { createPacketReader } from '../../app/lib/packetReader.js';

const fakeRes = (out) => ({ ok: true, status: 200, json: async () => out });

test('runExtraction (receipts, documents) sends store: false', async () => {
  const real = globalThis.fetch; let seen;
  globalThis.fetch = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return fakeRes({ output_text: '{}' }); };
  try { await runExtraction(Object.keys(DOC_TYPES)[0], { apiKey: 'fake-key', dataUrl: 'data:image/png;base64,AAAA' }); } finally { globalThis.fetch = real; }
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.body.store, false);
});

test('callRateConModel sends store: false', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = JSON.parse(init.body); return fakeRes({ output_text: '{}' }); };
  await callRateConModel({ apiKey: 'fake-key', model: 'gpt-4o-mini', mime: 'application/pdf', name: 'fake.pdf', bytes: Buffer.from('%PDF-fake'), fetchImpl });
  assert.equal(seen.store, false);
});

test('packet reader sends store: false', async () => {
  let seen;
  const r = createPacketReader({ apiKey: 'fake-key', transport: async ({ body }) => { seen = body; return { fields: [] }; } });
  await r.nameFields([{ id: '1', page: 1, label: 'Legal name', kind: 'text', box: [0, 0, 1, 1] }]);
  assert.equal(seen.store, false);
});

test('no OpenAI request body in app/ is missing store: false', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(js|jsx|ts|tsx|mjs)$/.test(f) ? [p] : []; });
  const hits = walk('app').filter((p) => /api\.openai\.com/.test(readFileSync(p, 'utf8')));
  assert.ok(hits.length >= 3, hits.join());
  for (const p of hits) assert.match(readFileSync(p, 'utf8'), /store: false/, p);
});
