// Target of credential forms submitted before the page script loaded. The body is never read,
// logged or echoed; we just send the browser back (303 -> GET) to the form with ?nojs=1.
import { fallbackTarget } from '../../lib/authFormsCore';

export const dynamic = 'force-dynamic';

function back(req) {
  const u = new URL(req.url);
  const to = new URL(fallbackTarget(u.searchParams.get('back')), u.origin).toString();
  return new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } });
}
export async function POST(req) { return back(req); }
export async function GET(req) { return back(req); }
