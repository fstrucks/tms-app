// Load pictures: gallery photos on a load, counted with Load documents, never Needs attention.
// Fake rows and fake files only. No live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { LOAD_PICTURE_TYPE, docTypeLabel } from '../../app/lib/docTypes.js';
import { needsAttention, fetchNeedsAttention, selectNeedsAttention } from '../../app/lib/docsInbox.js';
import { selectInboxTeamDocs } from '../../app/lib/docsInboxQuery.js';
import { pageLoadVault } from '../../app/lib/loadVault.js';
import { vaultTileCounts } from '../../app/lib/vaultCounts.js';
import { isImagePath } from '../../app/lib/loadDocs.js';
import { loadDeleteDocsLabel, loadDeletePrompt } from '../../app/lib/loadDelete.js';
import { bundleFiles } from '../../app/lib/invoiceBundle.js';
import {
  PICTURE_BATCH_MAX, PICTURE_JPEG_QUALITY, PICTURE_MAX_EDGE, PICTURE_RAW_MAX,
  isPictureFile, pictureFileError, prepareLoadPicture, resolveImageType, runPictureBatch,
  splitPictureBatch, uploadLoadPicture,
} from '../../app/lib/loadPictures.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const DRIVER = '00000000-0000-4000-8000-0000000000a2';
const DRIVER2 = '00000000-0000-4000-8000-0000000000a3';
const DISP = '00000000-0000-4000-8000-0000000000a4';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const L2 = '00000000-0000-4000-8000-0000000000b2';
const at = (n) => new Date(Date.UTC(2026, 9, 25, 0, 0, n)).toISOString();
const jpg = (name, bytes = 32) => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });

function load(id, extra = {}) {
  return {
    id, user_id: OWNER, broker_name: 'Acme (FAKE)', broker_load_number: 'TEST-PICS-1', status: 'in_transit',
    assigned_driver_user_id: DRIVER, show_rate_to_driver: false, created_at: at(1), ...extra,
  };
}

function pic(id, userId, loadId, n) {
  return {
    id, user_id: userId, doc_type: 'load_picture', source: 'upload', load_id: loadId,
    truck_id: null, service_record_id: null, handled_at: null,
    file_path: `${userId}/${id}.jpg`, original_filename: `${id}.jpg`, created_at: at(n),
  };
}

function tablesFor(documents) {
  return {
    company_members: [
      { user_id: DRIVER, 'company_profiles.owner_id': OWNER },
      { user_id: DRIVER2, 'company_profiles.owner_id': OWNER },
      { user_id: DISP, 'company_profiles.owner_id': OWNER },
    ],
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    loads: [
      load(L1),
      load(L2, { assigned_driver_user_id: DRIVER2, broker_load_number: 'TEST-PICS-2', broker_name: 'Beta (FAKE)' }),
    ],
    drivers: [],
    scale_tickets: [],
    documents,
  };
}

function listed(documents, role, userId) {
  return pageLoadVault({
    docs: documents, loads: tablesFor(documents).loads, role, userId, ownerId: OWNER, limit: 50,
  });
}

function counted(documents, role, userId) {
  return vaultTileCounts(fakeSupabase({ tables: tablesFor(documents) }), {
    ownerId: OWNER, role, userId, profileId: 'p1',
  });
}

test('doc_type load_picture needs no SQL: the column is plain text with no check', () => {
  const create = read('../../supabase/migrations/20261010000050_documents_table.sql');
  assert.match(create, /doc_type text,/);
  assert.doesNotMatch(create, /check\s*\([^)]*doc_type/i);
  const note = read('../../supabase/migrations/20261017002100_truck_tab.sql');
  assert.match(note, /documents\.doc_type is plain text \(no check\)/);
  const comment = read('../../supabase/migrations/20261020000200_load_docs_scale_bol.sql');
  assert.match(comment, /Plain text/);
  assert.equal(LOAD_PICTURE_TYPE, 'load_picture');
  assert.equal(docTypeLabel('load_picture'), 'Load pictures');
  assert.equal(isImagePath(`${OWNER}/photo.HEIC`), true);
  assert.equal(isImagePath(`${OWNER}/photo.pdf`), false);
});

test('a picture never needs attention, linked or not', async () => {
  const linked = pic('linked', DRIVER, L1, 4);
  const loose = pic('loose', DRIVER, null, 5);
  const bol = { id: 'bol', user_id: DRIVER, doc_type: 'bol', source: 'upload', load_id: null, truck_id: null, file_path: `${DRIVER}/b.pdf`, original_filename: 'b.pdf', created_at: at(6) };
  assert.equal(needsAttention(linked), false);
  assert.equal(needsAttention(loose), false);
  assert.equal(needsAttention(bol), true);
  assert.deepEqual(selectNeedsAttention([linked, loose, bol]).map((d) => d.id), ['bol']);
  const tables = tablesFor([linked, loose, bol]);
  const mine = await fetchNeedsAttention(fakeSupabase({ tables, user: { id: DRIVER } }));
  assert.deepEqual(mine.documents.map((d) => d.id), ['bol']);
  const team = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'dispatcher', userId: DISP });
  assert.deepEqual(team.documents.map((d) => d.id), ['bol']);
});

test('tile equals list for owner, dispatcher, and driver when pictures are present, including after delete', async () => {
  const documents = [
    pic('own-pic', OWNER, L1, 10),
    pic('drv-pic', DRIVER, L1, 11),
    pic('other-pic', DRIVER2, L2, 12),
    pic('unlinked', OWNER, null, 13),
    { id: 'bol', user_id: OWNER, doc_type: 'bol', source: 'upload', load_id: L1, truck_id: null, file_path: `${OWNER}/b.pdf`, original_filename: 'b.pdf', created_at: at(14) },
    { id: 'loose-bol', user_id: OWNER, doc_type: 'bol', source: 'upload', load_id: null, truck_id: null, file_path: `${OWNER}/loose.pdf`, original_filename: 'loose.pdf', created_at: at(15) },
    { id: 'receipt', user_id: OWNER, doc_type: 'receipt', source: 'upload', load_id: L1, truck_id: null, file_path: `${OWNER}/r.jpg`, original_filename: 'r.jpg', created_at: at(16) },
  ];
  for (const [role, userId] of [['owner', OWNER], ['dispatcher', DISP], ['driver', DRIVER]]) {
    const page = listed(documents, role, userId);
    const counts = await counted(documents, role, userId);
    assert.equal(counts.loadDocs, page.rows.length, role);
    assert.equal(page.rows.some((r) => r.doc.id === 'receipt'), false, role);
    assert.equal(page.rows.some((r) => r.doc.id === 'loose-bol'), false, role);
  }
  const owner = listed(documents, 'owner', OWNER);
  const dispatcher = listed(documents, 'dispatcher', DISP);
  const driver = listed(documents, 'driver', DRIVER);
  assert.equal(owner.rows.some((r) => r.doc.id === 'unlinked'), true);
  assert.equal(dispatcher.rows.some((r) => r.doc.id === 'unlinked'), false);
  assert.equal(dispatcher.rows.some((r) => r.doc.id === 'drv-pic'), true);
  assert.equal(dispatcher.rows.some((r) => r.doc.id === 'other-pic'), true);
  assert.equal(driver.rows.some((r) => r.doc.id === 'own-pic'), true);
  assert.equal(driver.rows.some((r) => r.doc.id === 'drv-pic'), true);
  assert.equal(driver.rows.some((r) => r.doc.id === 'other-pic'), false, 'another driver\'s load');
  assert.equal(driver.rows.some((r) => r.doc.id === 'unlinked'), false);
  const byType = pageLoadVault({
    docs: documents, loads: tablesFor(documents).loads, role: 'owner', userId: OWNER, ownerId: OWNER,
    filters: { type: 'load_picture' }, limit: 50,
  });
  assert.deepEqual(byType.rows.map((r) => r.doc.id).sort(), ['drv-pic', 'other-pic', 'own-pic', 'unlinked']);

  const after = documents.filter((d) => d.id !== 'drv-pic');
  for (const [role, userId] of [['owner', OWNER], ['dispatcher', DISP], ['driver', DRIVER]]) {
    const page = listed(after, role, userId);
    const counts = await counted(after, role, userId);
    assert.equal(page.rows.some((r) => r.doc.id === 'drv-pic'), false, role);
    assert.equal(counts.loadDocs, page.rows.length, `${role} after delete`);
    assert.equal(counts.loadDocs, listed(documents, role, userId).rows.length - 1, `${role} dropped one`);
  }
});

test('deleting a load counts the uploader\'s pictures with the other linked documents', () => {
  const docs = [
    { own: true, source: 'document', doc_type: 'bol' },
    { own: true, source: 'document', doc_type: 'load_picture' },
    { own: true, source: 'document', doc_type: 'load_picture' },
    { own: false, source: 'document', doc_type: 'load_picture' },
    { own: true, source: 'scale_ticket', doc_type: 'scale_ticket' },
  ];
  const ownDocs = docs.filter((d) => d.own !== false && d.source !== 'scale_ticket');
  const teamDocs = docs.filter((d) => d.own === false && d.source !== 'scale_ticket').length;
  assert.equal(ownDocs.length, 3);
  assert.equal(teamDocs, 1);
  assert.equal(loadDeleteDocsLabel(ownDocs.length, teamDocs, 0), 'Also delete your 3 linked documents; 1 team document will be unlinked, not deleted');
  assert.equal(loadDeletePrompt(ownDocs.length, true, {}, teamDocs, 0), 'Delete this load, its stops and your 3 documents? 1 team document will be kept, unlinked.');
  const page = read('../../app/loads/[id]/page.js');
  const ownLine = page.slice(page.indexOf('const ownDocs'), page.indexOf('const paperwork'));
  assert.match(ownLine, /d\.own !== false && d\.source !== 'scale_ticket'/);
  assert.doesNotMatch(ownLine, /load_picture/);
});

test('pictures are photos only, 10 at a time, and one failure does not drop the rest', async () => {
  assert.equal(isPictureFile(jpg('a.jpg')), true);
  assert.equal(isPictureFile({ name: 'IMG.HEIC', type: '', size: 10 }), true);
  assert.equal(resolveImageType({ name: 'IMG.HEIC', type: 'application/octet-stream' }), 'image/heic');
  assert.equal(isPictureFile({ name: 'note.pdf', type: 'application/pdf', size: 10 }), false);
  assert.equal(isPictureFile({ name: 'icon.svg', type: 'image/svg+xml', size: 10 }), false);
  assert.match(pictureFileError({ name: 'empty.jpg', type: 'image/jpeg', size: 0 }), /empty/);
  const huge = jpg('huge.jpg', 1);
  Object.defineProperty(huge, 'size', { value: PICTURE_RAW_MAX + 1 });
  assert.match(pictureFileError(huge), /too large/);

  const files = [
    ...Array.from({ length: PICTURE_BATCH_MAX }, (_, i) => jpg(`p${i}.jpg`)),
    new File([new Uint8Array(8)], 'skip.pdf', { type: 'application/pdf' }),
    jpg('extra.jpg'),
  ];
  const split = splitPictureBatch(files);
  assert.equal(split.accepted.length, 10);
  assert.equal(split.errors.length, 2);
  assert.match(split.errors.find((e) => e.name === 'skip.pdf').error, /Pictures only/);
  assert.match(split.errors.find((e) => e.name === 'extra.jpg').error, /Only 10 pictures/);

  const uploaded = [];
  const batch = await runPictureBatch([jpg('ok.jpg'), jpg('fail.jpg'), new File([new Uint8Array(4)], 'no.pdf', { type: 'application/pdf' }), jpg('also.jpg')], {
    prepare: async (file) => ({ ok: true, file, contentType: 'image/jpeg' }),
    upload: async (prepared) => {
      uploaded.push(prepared.file.name);
      if (prepared.file.name.startsWith('fail')) return { ok: false, error: 'Upload failed.' };
      return { ok: true, id: prepared.file.name };
    },
  });
  assert.deepEqual(uploaded, ['ok.jpg', 'fail.jpg', 'also.jpg']);
  assert.deepEqual(batch.saved, ['ok.jpg', 'also.jpg']);
  assert.equal(batch.errors.length, 2);
});

test('big photos are resized to JPEG; a file that cannot be decoded uploads as-is only when small', async () => {
  const encoded = jpg('yard.jpg', 40);
  let seen = null;
  const resized = await prepareLoadPicture(jpg('yard.png', 80), {
    decode: async () => ({ w: 4000, h: 3000, src: {}, close() { seen = 'closed'; } }),
    encodeJpeg: async (decoded, opts) => {
      assert.equal(decoded.w, 4000);
      assert.equal(opts.maxEdge, PICTURE_MAX_EDGE);
      assert.equal(opts.quality, PICTURE_JPEG_QUALITY);
      assert.equal(opts.name, 'yard.jpg');
      return encoded;
    },
  });
  assert.equal(resized.ok, true);
  assert.equal(resized.file, encoded);
  assert.equal(resized.contentType, 'image/jpeg');
  assert.equal(seen, 'closed');

  const converted = jpg('shot.jpg', 20);
  let decodedName = '';
  const heic = await prepareLoadPicture(new File([new Uint8Array(20)], 'shot.HEIC', { type: '' }), {
    convertHeic: async () => converted,
    decode: async (file) => { decodedName = file.name; return { w: 100, h: 100, src: {}, close() {} }; },
    encodeJpeg: async () => jpg('shot.jpg', 16),
  });
  assert.equal(decodedName, 'shot.jpg');
  assert.equal(heic.ok, true);
  assert.equal(heic.contentType, 'image/jpeg');

  const small = new File([new Uint8Array(24)], 'phone.heic', { type: 'image/heic' });
  const asIs = await prepareLoadPicture(small, {
    convertHeic: async () => { throw new Error('no heic'); },
    decode: async () => { throw new Error('no decode'); },
  });
  assert.equal(asIs.ok, true);
  assert.equal(asIs.asIs, true);
  assert.equal(asIs.contentType, 'image/heic');

  const gif = new File([new Uint8Array(24)], 'anim.gif', { type: 'image/gif' });
  const gifResult = await prepareLoadPicture(gif, {
    decode: async () => { throw new Error('no decode'); },
  });
  assert.equal(gifResult.ok, false);
  assert.match(gifResult.error, /Export it as JPEG/);

  const big = jpg('big.jpg', 1);
  Object.defineProperty(big, 'size', { value: 12 * 1024 * 1024 });
  const failed = await prepareLoadPicture(big, {
    decode: async () => { throw new Error('no decode'); },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Export it as JPEG/);
});

test('upload stores a documents row and removes it when the load link fails', async () => {
  function client() {
    const sb = fakeSupabase({ tables: { documents: [] }, user: { id: DRIVER } });
    const removed = [];
    const uploaded = [];
    sb.storage.from = () => ({
      upload: async (path, _file, opts) => { uploaded.push({ path, type: opts.contentType }); return { error: null }; },
      remove: async (paths) => { removed.push(...paths); return { error: null }; },
    });
    sb.auth.getSession = async () => ({ data: { session: { access_token: 't' } } });
    return { sb, removed, uploaded };
  }
  const ok = client();
  const calls = [];
  const saved = await uploadLoadPicture(ok.sb, { userId: DRIVER, loadId: L1, file: jpg('yard.jpg'), contentType: 'image/jpeg' }, {
    fetchImpl: async (url, opts) => { calls.push({ url, body: opts.body }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
  });
  assert.equal(saved.ok, true);
  assert.equal(ok.sb.db.documents.length, 1);
  assert.equal(ok.sb.db.documents[0].doc_type, 'load_picture');
  assert.equal(ok.sb.db.documents[0].load_id, null);
  assert.equal(ok.sb.db.documents[0].user_id, DRIVER);
  assert.equal(ok.uploaded[0].type, 'image/jpeg');
  assert.match(ok.uploaded[0].path, new RegExp(`^${DRIVER}/`));
  assert.match(calls[0].url, /\/api\/documents\/.+\/load$/);
  assert.equal(JSON.parse(calls[0].body).loadId, L1);
  assert.equal(ok.removed.length, 0);

  const bad = client();
  const missed = await uploadLoadPicture(bad.sb, { userId: DRIVER, loadId: L1, file: jpg('yard.jpg'), contentType: 'image/jpeg' }, {
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Load not found.' }), { status: 404 }),
  });
  assert.equal(missed.ok, false);
  assert.match(missed.error, /Load not found/);
  assert.equal(bad.sb.db.documents.length, 0);
  assert.equal(bad.removed.length, 1);
});

test('pictures stay out of the invoice bundle and the screen offers the photo library', () => {
  const files = bundleFiles({ load_ref: { load_number: 'TEST-PICS-1' } }, [
    { id: 'p', doc_type: 'load_picture', file_path: `${OWNER}/a.jpg`, original_filename: 'a.jpg', created_at: at(1) },
    { id: 'b', doc_type: 'bol', file_path: `${OWNER}/b.pdf`, original_filename: 'b.pdf', created_at: at(2) },
  ]);
  assert.deepEqual(files.map((f) => f.kind), ['invoice', 'bol']);
  const ui = read('../../app/components/LoadPictures.js');
  const lib = read('../../app/lib/loadPictures.js');
  assert.match(ui, /accept="image\/\*"\s+multiple/);
  assert.match(ui, /Add pictures/);
  assert.match(ui, />Close</);
  assert.match(ui, /minHeight: 44/);
  assert.match(ui, /Delete this picture\? The load is kept\./);
  assert.match(ui, /data-testid="load-picture-viewer"/);
  assert.match(ui, /data-testid="load-picture-progress"/);
  assert.doesNotMatch(ui, /\b(AI|bot)\b/);
  assert.match(lib, /imageOrientation:\s*'from-image'/);
  assert.match(lib, /toBlob\(resolve, 'image\/jpeg', quality\)/);
  assert.match(read('../../app/loads/[id]/page.js'), /<LoadPictures /);
  assert.match(read('../../app/components/LoadDocsCard.js'), /<LoadPictures /);
  assert.match(read('../../app/documents/vault/page.js'), /d\.own && d\.doc_type === LOAD_PICTURE_TYPE/);
  assert.match(read('../../app/documents/vault/page.js'), /deleteDocument\(supabase, d, 'documents'\)/);
  assert.match(read('../../app/lib/docsInbox.js'), /doc\.doc_type === LOAD_PICTURE_TYPE/);
  assert.match(read('../../app/lib/loadVault.js'), /LOAD_PICTURE_TYPE/);
});
