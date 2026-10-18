// React side of credential-safe forms; pure helpers live in authFormsCore.js (also used by the API route).
import { useEffect, useState } from 'react';
import { scrubLocation } from './authFormsCore';

export * from './authFormsCore';

// false on the server and first paint, true once React has hydrated. Also scrubs leaked params.
export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => { scrubLocation(); setH(true); }, []);
  return h;
}
