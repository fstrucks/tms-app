// One part of a company export, from the emailed link. No sign-in; the link token is the key.
import { getExportPart } from '../../../../lib/companyExportRoutes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req, ctx) { return getExportPart(req, ctx?.params?.token, ctx?.params?.n, ctx?.deps || {}); }
