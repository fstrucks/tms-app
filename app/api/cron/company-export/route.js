// Builds company exports in short runs and removes old ones. Vercel Cron calls this daily as a
// backstop; each run also calls it with ?job=<id> to continue. Needs CRON_SECRET (Authorization: Bearer).
// If CRON_SECRET is unset or empty it answers 503 and runs nothing; a job then moves on only when the
// owner asks to export again (POST /api/company-export continues the open job).
import { cronCompanyExport } from '../../../lib/companyExportRoutes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export function GET(req, ctx) { return cronCompanyExport(req, ctx?.deps || {}); }
export function POST(req, ctx) { return cronCompanyExport(req, ctx?.deps || {}); }
