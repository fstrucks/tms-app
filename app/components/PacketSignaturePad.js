'use client';
// Adapter for Casey's SignaturePad (PR #61, app/components/SignaturePad.js).
// Contract: <SignaturePad onDone={({ dataUrl, signerName, signedAt, method }) => …} onCancel={…} initialName title />
//   dataUrl = trimmed PNG data URL, signedAt = ISO string, method = 'draw' | 'type'.
// When #61 is merged, swap the stub for the real pad by changing this ONE line to:
//   export { default } from './SignaturePad';
export { default } from './SignaturePadStub';
