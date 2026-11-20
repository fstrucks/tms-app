// Stamps expired shares and deletes old pings. Called by Vercel Cron (daily backstop) and can be run more
// often if the host plan allows. Expiry is also applied on every read/write, so a late cron never leaves a
// point visible past expires_at.
// Needs CRON_SECRET (Authorization: Bearer). If CRON_SECRET is unset or empty it answers 503 and runs nothing.
import { cronLocationShares } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req, ctx) { return cronLocationShares(req, ctx?.deps || {}); }
export function POST(req, ctx) { return cronLocationShares(req, ctx?.deps || {}); }
