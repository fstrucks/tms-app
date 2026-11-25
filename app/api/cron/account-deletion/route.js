// Finishes company deletions whose 14-day wait has ended, and retries any cleanup that
// stopped after the database step. Vercel Cron calls this daily.
// Set CRON_SECRET (Vercel sends Authorization: Bearer <CRON_SECRET>). Nothing runs if it is unset.
import { cronAccountDeletion } from '../../../lib/accountDeletionServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req, ctx) { return cronAccountDeletion(req, ctx?.deps || {}); }
export function POST(req, ctx) { return cronAccountDeletion(req, ctx?.deps || {}); }
