// GET ?tz=<IANA> → the load's "Stop times" PDF ({LOAD}_StopTimes.pdf). Same access as stop check-off: owner /
// management / dispatcher on the load's company, or the load's assigned driver. Times print in each stop's time zone
// (stops.timezone), else ?tz (the viewer's device), else Central.
import { loadDocsCtx } from '../../../../lib/loadDocsServer';
import { loadForStopTimes, delaysForLoad } from '../../../../lib/stopTimesServer';
import { stopTimesPdf, stopTimesFileName } from '../../../../lib/stopTimesPdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const r = await loadForStopTimes(x, params?.id); if (r.res) return r.res;
  const tz = new URL(req.url).searchParams.get('tz');
  const bytes = await stopTimesPdf(r.load, r.company, { tz, delays: await delaysForLoad(x.svc, r.load.id) });
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${stopTimesFileName(r.load)}"` } });
}
