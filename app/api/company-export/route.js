// Company data export. GET: status of the latest job. POST: start one (company owner only, 3 a day).
// The signed-in user comes from auth.getUser(token); ids in the body are ignored.
import { getCompanyExport, postCompanyExport } from '../../lib/companyExportRoutes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export function GET(req, ctx) { return getCompanyExport(req, ctx?.deps || {}); }
export function POST(req, ctx) { return postCompanyExport(req, ctx?.deps || {}); }
