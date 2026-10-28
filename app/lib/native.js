// Native app helpers. In the iOS/Android app the camera and photo library open through the
// system camera/photos UI; in a browser every function here is a no-op so callers keep their
// normal <input type="file"> flow. Returns File objects, so existing upload code is reused as is.
// The camera plugin is loaded with a dynamic import, only inside the native app.

const MIME = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif' };
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif' };

const defaultWin = () => (typeof window === 'undefined' ? undefined : window);
const defaultLoad = () => import('@capacitor/camera');

export function isNative(win = defaultWin()) {
  try { return !!win?.Capacitor?.isNativePlatform?.(); } catch { return false; }
}

// The user closing the camera or picker isn't an error.
export const isCancel = (err) => /cancel|no image picked|no images picked/i.test(String(err?.message || err || ''));

async function toFile(photo, i, fetchImpl) {
  const res = await fetchImpl(photo.webPath);
  const blob = await res.blob();
  const type = MIME[String(photo.format || '').toLowerCase()] || blob.type || 'image/jpeg';
  const name = `photo-${Date.now()}-${i + 1}.${EXT[type] || 'jpg'}`;
  return new File([blob], name, { type, lastModified: Date.now() });
}

// Native camera. Resolves a File, or null (browser, or the user cancelled).
export async function takePhoto({ win = defaultWin(), load = defaultLoad, fetchImpl = globalThis.fetch } = {}) {
  if (!isNative(win)) return null;
  const { Camera, CameraResultType, CameraSource } = await load();
  try {
    const photo = await Camera.getPhoto({ source: CameraSource.Camera, resultType: CameraResultType.Uri, quality: 90, correctOrientation: true, saveToGallery: false });
    return await toFile(photo, 0, fetchImpl);
  } catch (err) {
    if (isCancel(err)) return null;
    throw err;
  }
}

// Native photo library. Resolves File[] ([] in a browser or when the user cancelled).
export async function pickImage({ multiple = false, limit = 0, win = defaultWin(), load = defaultLoad, fetchImpl = globalThis.fetch } = {}) {
  if (!isNative(win)) return [];
  const { Camera } = await load();
  try {
    const { photos = [] } = await Camera.pickImages({ quality: 90, correctOrientation: true, limit: multiple ? limit : 1 });
    const picked = multiple ? photos : photos.slice(0, 1);
    return await Promise.all(picked.map((p, i) => toFile(p, i, fetchImpl)));
  } catch (err) {
    if (isCancel(err)) return [];
    throw err;
  }
}

// For an image <input type="file"> click handler. In the native app it stops the web picker,
// opens the native camera ('camera') or photo library ('photos') and calls onFiles(File[])
// ([] when cancelled or on an error). In a browser it does nothing and returns false, so the
// input opens exactly as before.
export function nativeImageInput(e, { source, multiple = false, onFiles, ...deps }) {
  if (!isNative(deps.win ?? defaultWin())) return false;
  e?.preventDefault?.();
  const run = source === 'camera'
    ? takePhoto(deps).then((f) => (f ? [f] : []))
    : pickImage({ multiple, ...deps });
  run.then(onFiles, (err) => { console.warn('Native picker failed', err); onFiles([]); });
  return true;
}

// Android back button: pages with nowhere to go back to (home, sign-in) close the app;
// elsewhere go back in history, or to home when there is no history.
export const ROOT_PATHS = ['/', '/login'];
export function backAction({ pathname = '/', canGoBack = false } = {}) {
  if (ROOT_PATHS.includes(pathname)) return 'exit';
  return canGoBack ? 'back' : 'home';
}
