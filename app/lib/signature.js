// Step E (signatures): pure helpers for SignaturePad. No DOM; unit-tested in tests/js/signature.test.mjs.

export const SIGNATURE_METHODS = ['draw', 'type'];
export const SIGNER_NAME_MAX = 80;
export const TRIM_PADDING = 8;

// Returns trimmed name or '' if invalid (blank, too long, no letters).
export function cleanSignerName(name) {
  if (typeof name !== 'string') return '';
  const s = name.replace(/\s+/g, ' ').trim();
  if (!s || s.length > SIGNER_NAME_MAX || !/\p{L}/u.test(s)) return '';
  return s;
}
export function isValidSignerName(name) { return cleanSignerName(name) !== ''; }

// Bounding box of pixels with alpha > threshold in an RGBA array (width*height*4).
// Returns { x, y, w, h } padded and clamped to the canvas, or null when empty.
export function findInkBounds(data, width, height, padding = TRIM_PADDING, alphaThreshold = 0) {
  if (!data || !width || !height || data.length < width * height * 4) return null;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const p = Math.max(0, Math.floor(padding));
  const x0 = Math.max(0, minX - p), y0 = Math.max(0, minY - p);
  const x1 = Math.min(width - 1, maxX + p), y1 = Math.min(height - 1, maxY + p);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Quadratic-curve midpoint smoothing: segment from previous midpoint to current midpoint, control = previous point.
export function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// Builds the onDone payload, or null if anything is missing/invalid.
export function buildSignaturePayload({ dataUrl, signerName, method, now = new Date() }) {
  const name = cleanSignerName(signerName);
  if (!name) return null;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
  if (!SIGNATURE_METHODS.includes(method)) return null;
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  return { dataUrl, signerName: name, signedAt: d.toISOString(), method };
}

// Done is enabled when the name is valid and (draw: has ink) / (type: typed text present).
export function canFinish({ signerName, method, hasInk, typedText }) {
  if (!isValidSignerName(signerName)) return false;
  if (method === 'draw') return !!hasInk;
  if (method === 'type') return cleanSignerName(typedText ?? signerName) !== '';
  return false;
}
