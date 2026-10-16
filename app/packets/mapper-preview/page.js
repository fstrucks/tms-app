'use client';
// Dev-only preview of the mapping screen with FAKE data (for screenshots). 404 in production builds.
import { notFound, useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import PacketMapper from '../PacketMapper';

const W = 1700, H = 2200;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/><g font-family="Helvetica" font-size="36" fill="#111">
<text x="140" y="180" font-size="52" font-weight="bold">TEST BROKERAGE LLC - CARRIER SETUP (FAKE)</text>
<text x="140" y="330">Legal Name:</text><line x1="380" y1="335" x2="1500" y2="335" stroke="#000" stroke-width="3"/>
<text x="140" y="430">MC Number:</text><line x1="380" y1="435" x2="900" y2="435" stroke="#000" stroke-width="3"/>
<text x="960" y="430">DOT:</text><line x1="1060" y1="435" x2="1500" y2="435" stroke="#000" stroke-width="3"/>
<text x="140" y="530">Phone:</text><line x1="300" y1="535" x2="900" y2="535" stroke="#000" stroke-width="3"/>
<text x="140" y="680" font-weight="bold">PAYMENT</text><rect x="140" y="720" width="34" height="34" fill="none" stroke="#000" stroke-width="3"/><text x="195" y="750">ACH / direct deposit</text>
<text x="140" y="850">Routing #:</text><line x1="360" y1="855" x2="900" y2="855" stroke="#000" stroke-width="3"/>
<text x="140" y="950">Account #:</text><line x1="360" y1="955" x2="900" y2="955" stroke="#000" stroke-width="3"/>
<text x="140" y="1150">Signature:</text><line x1="360" y1="1155" x2="1000" y2="1155" stroke="#000" stroke-width="3"/>
<text x="1060" y="1150">Date:</text><line x1="1170" y1="1155" x2="1500" y2="1155" stroke="#000" stroke-width="3"/></g></svg>`;
const URL_ = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const F = (id, label, box, kind, key, extra = {}) => ({ id, field_key: id, page: 1, kind, label, box, profile_key: key, confidence: 0.9, source: 'model', needs_confirm: key === 'bank_routing' || key === 'bank_account', confirmed: false, value: '', check: null, ...extra });
const SIG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120"><path d="M10 90 C 60 10, 110 10, 140 80 S 220 120, 260 40 S 360 20, 380 90 S 470 100, 520 50 L 620 60" fill="none" stroke="#111827" stroke-width="7" stroke-linecap="round"/></svg>`;
const SIG_URL = `data:image/svg+xml;utf8,${encodeURIComponent(SIG_SVG)}`;
const FIELDS = [
  F('f1', 'Legal Name:', [380, 305, 1500, 337], 'text', 'legal_name', { value: 'Test Trucking Co (FAKE)', check: { ok: true } }),
  F('f2', 'MC Number:', [380, 405, 900, 437], 'text', 'mc_number', { value: 'MC-000000', check: { ok: true } }),
  F('f3', 'DOT:', [1060, 405, 1500, 437], 'text', 'dot_number', { value: '12', check: { ok: false, message: 'USDOT number should be 5-8 digits' } }),
  F('f4', 'Phone:', [300, 505, 900, 537], 'text', null, { source: 'local', confidence: 0 }),
  F('f5', 'ACH / direct deposit', [140, 720, 174, 754], 'checkbox', null, { source: 'local', confidence: 0 }),
  F('f6', 'Routing #:', [360, 825, 900, 857], 'text', 'bank_routing', { value: '•••0015', has_value: true, sensitive: true }),
  F('f7', 'Account #:', [360, 925, 900, 957], 'text', 'bank_account', { value: '•••0000', has_value: true, sensitive: true, confirmed: true }),
  F('f8', 'Signature:', [360, 1125, 1000, 1157], 'signature', 'signature'),
  F('f9', 'Date:', [1170, 1125, 1500, 1157], 'date', 'date'),
];
function Preview() {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = useSearchParams();
  const renderPage = useCallback(() => ({ url: URL_, w: W, h: H }), []);
  const role = q.get('role') || 'owner';
  const packet = { subject: 'TEST carrier packet - fake data', source: 'email', status: 'review', page_count: 1, manual_reason: q.get('manual') || null };
  const signed = q.get('signed') === '1';
  const fields = q.get('manual') ? [] : FIELDS.map((f) => (signed && f.id === 'f8' ? { ...f, signed: true, signer_name: 'Test Owner (FAKE)', signed_at: '2026-10-16T19:00:00Z' } : signed && f.id === 'f9' ? { ...f, value: '10/16/2026' } : f));
  const loadSignatures = useCallback(async () => ({ urls: { f8: SIG_URL } }), []);
  const fake = async () => ({ error: 'Preview only (fake data).' });
  return <PacketMapper packet={{ ...packet, id: 'preview' }} fields={fields} initialSel={q.get('sel')} initialSigMenu={q.get('menu')} loadSignatures={loadSignatures} onSign={fake} onFill={fake} onClearSig={fake} canEdit={role !== 'driver'} pageCount={1} renderPage={renderPage} onSave={async () => ({ error: 'Preview only (fake data).' })} />;
}
export default function Page() { return <Suspense><Preview /></Suspense>; }
