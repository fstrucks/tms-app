'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '../../lib/supabase';
import { safeNext, loginHref } from '../../lib/safeNext';

// Magic-link landing page. The Supabase client has detectSessionInUrl off on this route, so the
// session is set here exactly once: ?code (PKCE) via exchangeCodeForSession, or #access_token
// (implicit) via setSession. Errors in the URL, a missing code/token or a failed exchange show the
// error right away; the 8s timeout is only a backstop.
let run = null; // React strict mode runs effects twice in dev: the exchange runs once per page load, both runs await it

export default function AuthCallback() {
  const [failed, setFailed] = useState(false);
  const [next, setNext] = useState('/documents');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const n = safeNext(q.get('next'));
    setNext(n);
    let alive = true;
    const fail = (why) => { if (why) console.error('[auth] callback', why); if (alive) setFailed(true); };
    const t = setTimeout(() => fail('timeout'), 8000);
    const finish = () => { clearTimeout(t); if (alive) window.location.replace(n); };
    if (q.get('error') || q.get('error_code') || h.get('error') || h.get('error_code')) {
      clearTimeout(t); fail(q.get('error_description') || h.get('error_description') || 'link error');
      return () => { alive = false; };
    }
    const supabase = getSupabase();
    if (!supabase) { clearTimeout(t); fail('not configured'); return () => { alive = false; }; }
    if (!run) {
      run = (async () => {
        const code = q.get('code');
        const at = h.get('access_token'), rt = h.get('refresh_token');
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (at && rt) {
          const { error } = await supabase.auth.setSession({ access_token: at, refresh_token: rt });
          if (error) throw error;
        }
        const { data } = await supabase.auth.getSession();
        if (!data?.session) throw new Error('no code, token or session');
      })();
    }
    run.then(finish, (e) => { clearTimeout(t); fail(e); });
    return () => { alive = false; };
  }, []);
  return (
    <main style={{ padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' }}>
      {failed
        ? <p role="alert">This sign-in link didn't work or has expired. <a href={loginHref(next)} style={{ color: '#2563eb' }}>Try again</a>.</p>
        : <p aria-live="polite">Signing you in…</p>}
    </main>
  );
}
