import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNative, isCancel, takePhoto, pickImage, nativeImageInput } from '../../app/lib/native.js';

const neverLoad = () => { throw new Error('camera plugin must not load on the web'); };
const webWin = {};
const nativeWin = { Capacitor: { isNativePlatform: () => true } };
const fetchImpl = async () => ({ blob: async () => new Blob(['img'], { type: 'image/jpeg' }) });

test('isNative is false in a browser, without Capacitor, or when the check throws', () => {
  assert.equal(isNative(undefined), false);
  assert.equal(isNative(webWin), false);
  assert.equal(isNative({ Capacitor: { isNativePlatform: () => false } }), false);
  assert.equal(isNative({ Capacitor: { isNativePlatform: () => { throw new Error('x'); } } }), false);
  assert.equal(isNative(nativeWin), true);
});

test('web fallbacks: no plugin load, takePhoto null, pickImage []', async () => {
  assert.equal(await takePhoto({ win: webWin, load: neverLoad }), null);
  assert.deepEqual(await pickImage({ win: webWin, load: neverLoad, multiple: true }), []);
});

test('nativeImageInput leaves the web input alone', () => {
  let prevented = false, called = false;
  const r = nativeImageInput({ preventDefault: () => { prevented = true; } }, { source: 'camera', onFiles: () => { called = true; }, win: webWin, load: neverLoad });
  assert.equal(r, false);
  assert.equal(prevented, false);
  assert.equal(called, false);
});

test('native camera returns a File for existing upload code', async () => {
  const load = async () => ({ CameraSource: { Camera: 'CAMERA' }, CameraResultType: { Uri: 'uri' }, Camera: { getPhoto: async (o) => { assert.equal(o.source, 'CAMERA'); return { webPath: 'x', format: 'jpeg' }; } } });
  const f = await takePhoto({ win: nativeWin, load, fetchImpl });
  assert.ok(f instanceof File);
  assert.equal(f.type, 'image/jpeg');
  assert.match(f.name, /\.jpg$/);
});

test('native cancel is not an error', async () => {
  const load = async () => ({ CameraSource: {}, CameraResultType: {}, Camera: { getPhoto: async () => { throw new Error('User cancelled photos app'); }, pickImages: async () => { throw new Error('No images picked'); } } });
  assert.equal(await takePhoto({ win: nativeWin, load, fetchImpl }), null);
  assert.deepEqual(await pickImage({ win: nativeWin, load, fetchImpl, multiple: true }), []);
  assert.equal(isCancel(new Error('permission denied')), false);
});

test('nativeImageInput on native prevents the web picker and delivers files', async () => {
  const load = async () => ({ Camera: { pickImages: async (o) => { assert.equal(o.limit, 0); return { photos: [{ webPath: 'a', format: 'png' }, { webPath: 'b', format: 'jpeg' }] }; } } });
  let prevented = false;
  const files = await new Promise((resolve) => {
    const r = nativeImageInput({ preventDefault: () => { prevented = true; } }, { source: 'photos', multiple: true, onFiles: resolve, win: nativeWin, load, fetchImpl });
    assert.equal(r, true);
  });
  assert.equal(prevented, true);
  assert.deepEqual(files.map((f) => f.type), ['image/png', 'image/jpeg']);
});

test('single pick keeps one photo; plugin errors give []', async () => {
  const load = async () => ({ Camera: { pickImages: async (o) => { assert.equal(o.limit, 1); return { photos: [{ webPath: 'a' }, { webPath: 'b' }] }; } } });
  assert.equal((await pickImage({ win: nativeWin, load, fetchImpl })).length, 1);
  const bad = async () => ({ Camera: { pickImages: async () => { throw new Error('denied'); } } });
  const orig = console.warn; console.warn = () => {};
  const files = await new Promise((resolve) => nativeImageInput(null, { source: 'photos', onFiles: resolve, win: nativeWin, load: bad, fetchImpl }));
  console.warn = orig;
  assert.deepEqual(files, []);
});
