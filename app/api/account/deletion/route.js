// Sign-in required. The user id is taken from the session, never from the body.
// Company owners are scheduled 14 days out (demo and test companies run immediately).
// Database changes: public.account_deletion_apply, service role only.
import { getAccountDeletion, postAccountDeletion } from '../../../lib/accountDeletionServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req, ctx) { return getAccountDeletion(req, ctx?.deps || {}); }
export function POST(req, ctx) { return postAccountDeletion(req, ctx?.deps || {}); }
