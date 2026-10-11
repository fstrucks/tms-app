import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const missing = [
  !supabaseUrl && 'NEXT_PUBLIC_SUPABASE_URL',
  !supabaseAnonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
].filter(Boolean);

// Null when configured; otherwise a message the UI should show.
export const supabaseConfigError = missing.length
  ? `Supabase is not configured: missing ${missing.join(', ')}.`
  : null;

let client = null;

// Lazily create the client so a missing env var never breaks the build.
export function getSupabase() {
  if (supabaseConfigError) return null;
  if (!client) client = createClient(supabaseUrl, supabaseAnonKey);
  return client;
}

// True only when there is a signed-in session with an access token. Without one, supabase-js
// silently sends the anon key, and RLS (user_id = auth.uid()) returns [] with no error, which
// looks exactly like "no data". Check this before list fetches so we never show a false empty state.
export async function hasSession(supabase) {
  try {
    const { data } = await supabase.auth.getSession();
    return !!data?.session?.access_token;
  } catch (err) {
    console.error('[auth] getSession', err);
    return false;
  }
}
