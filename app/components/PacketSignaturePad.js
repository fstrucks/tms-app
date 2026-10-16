'use client';
// Adapter for Casey's SignaturePad (PR #61, app/components/SignaturePad.js).
// Contract: <SignaturePad onDone={({ dataUrl, signerName, signedAt, method }) => …} onCancel={…} initialName title />
//   dataUrl = trimmed PNG data URL, signedAt = ISO string, method = 'draw' | 'type'.
export { default } from './SignaturePad';
