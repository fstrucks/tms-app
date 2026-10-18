// QA #82 (RC-03, DBP-REF-7731): after a rate con re-run the load page kept "—" for Planned miles until a reload.
// Now extraction / re-run / create-load / route fill tell the load page to re-fetch. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notifyLoadChanged, onLoadChanged } from '../../app/lib/loadSync.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const L1 = '00000000-0000-4000-8000-0000000000e1', L2 = '00000000-0000-4000-8000-0000000000e2';

// Minimal window: events, a shared BroadcastChannel bus, localStorage, document.visibilityState.
function fakeWin(bus = new Set()) {
  const ls = new Map(), handlers = {}, docH = {};
  const on = (h) => (t, f) => ((h[t] ||= new Set()).add(f));
  const off = (h) => (t, f) => h[t]?.delete(f);
  const win = {
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o?.detail; } },
    addEventListener: on(handlers), removeEventListener: off(handlers),
    dispatchEvent: (e) => { [...(handlers[e.type] || [])].forEach((f) => f(e)); return true; },
    fire: (t, e) => [...(handlers[t] || [])].forEach((f) => f(e)),
    localStorage: { setItem: (k, v) => ls.set(k, v), getItem: (k) => ls.get(k) ?? null },
    document: { visibilityState: 'visible', addEventListener: on(docH), removeEventListener: off(docH), fire: (t) => [...(docH[t] || [])].forEach((f) => f({})) },
    BroadcastChannel: class { constructor() { this.onmessage = null; bus.add(this); this.bus = bus; }
      postMessage(m) { for (const c of this.bus) if (c !== this && c.onmessage) c.onmessage({ data: m }); } close() { this.bus.delete(this); } },
  };
  return win;
}

test('same tab: a re-run for this load re-fetches it; other loads are ignored; unsubscribe stops it', () => {
  const w = fakeWin(); const seen = [];
  const off = onLoadChanged(L1, (why) => seen.push(why), w);
  notifyLoadChanged(L2, w); assert.deepEqual(seen, []);
  notifyLoadChanged(L1, w); assert.deepEqual(seen, ['changed']);
  off(); notifyLoadChanged(L1, w); assert.deepEqual(seen, ['changed']);
});

test('other tab (BroadcastChannel) and back/forward-cache restore / tab shown again re-fetch', () => {
  const bus = new Set(); const docsTab = fakeWin(bus), loadTab = fakeWin(bus); const seen = [];
  onLoadChanged(L1, (why) => seen.push(why), loadTab);
  notifyLoadChanged(L1, docsTab);
  loadTab.fire('pageshow', { persisted: false });
  loadTab.fire('pageshow', { persisted: true });
  loadTab.document.fire('visibilitychange');
  assert.deepEqual(seen, ['changed', 'pageshow', 'visible']);
});

test('localStorage fallback (no BroadcastChannel) and no window are safe', () => {
  const w = fakeWin(); delete w.BroadcastChannel; const seen = [];
  onLoadChanged(L1, () => seen.push(1), w);
  w.fire('storage', { key: 'ph:load-changed', newValue: JSON.stringify({ loadId: L1 }) });
  w.fire('storage', { key: 'ph:load-changed', newValue: 'not json' });
  w.fire('storage', { key: 'other', newValue: JSON.stringify({ loadId: L1 }) });
  assert.equal(seen.length, 1);
  assert.doesNotThrow(() => notifyLoadChanged(L1, null));
  assert.equal(typeof onLoadChanged(L1, () => {}, null), 'function');
});

test('wiring: Documents notifies + router.refresh after extraction/re-run and create; load page re-fetches; Miles re-reads', () => {
  const docs = read('app/documents/page.js');
  assert.match(docs, /ai_extracted_data: body\.data[\s\S]{0,300}notifyLoadChanged\(linkedLoad\);\s*router\.refresh\(\);/);
  assert.match(docs, /notifyLoadChanged\(loadId\);\s*router\.refresh\(\);\s*router\.push\(`\/loads\/\$\{loadId\}`\)/);
  assert.match(read('app/api/extract/route.js'), /\.\.\.\(doc\.load_id \? \{ loadId: doc\.load_id \} : \{\}\)/);
  const page = read('app/loads/[id]/page.js');
  assert.match(page, /onLoadChanged\(id, \(\) => \{ if \(user\) refreshAll\(\); \}\)/);
  assert.match(page, /const refreshAll = \(\) => \{ router\.refresh\(\); return fetchRef\.current\(\); \}/);
  assert.match(page, /onRouteFilled=\{refreshAll\}/);
  assert.match(page, /refreshKey=\{dataVer\}/);
  assert.match(page, /list\?\.patchLoad\(id, \{ total_miles: l\.total_miles/);
  assert.match(read('app/components/LoadMileage.js'), /\[load\?\.id, refreshKey\]\);/);
  assert.match(read('app/components/LoadRouteCard.js'), /onRouteFilled\?\.\(\)/);
});
