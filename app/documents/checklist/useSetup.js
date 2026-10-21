'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '../../lib/supabase';
import { makeApi } from '../../lib/packetApi';

const { call } = makeApi(() => getSupabase()?.auth);

export function useSetup() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const apply = (j) => { setData(j); setLoading(false); return j; };
  const reload = useCallback(async () => {
    const j = await call('/api/setup');
    return apply(j);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const patch = useCallback(async (body) => {
    const j = await call('/api/setup', { method: 'PATCH', body: JSON.stringify(body) });
    if (!j.error || j.profile || j.setupNeeded || j.needsProfile) setData(j);
    return j;
  }, []);
  return { data, loading, reload, patch, call, setData };
}
