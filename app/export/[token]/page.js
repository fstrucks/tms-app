// Company export download page, opened from the emailed link. No sign-in; the link token is the key.
// Unknown, expired and removed links all get the same 404.
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { serviceClient } from '../../lib/packetServer';
import { exportLinkPage, fmtBytes, MANY_PARTS_NOTE, RETENTION_NOTE } from '../../lib/companyExportLink';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = {
  title: 'Company export',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

const day = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
const box = { maxWidth: 640, margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 };

export default async function ExportPage({ params }) {
  let r;
  try { r = await exportLinkPage(serviceClient(), params?.token, { headers: headers() }); } catch { notFound(); }
  if (r.status === 429) return <main style={box}><h1>Company export</h1><p>Too many requests. Wait a few minutes and reload this page.</p></main>;
  if (r.status !== 200) notFound();
  const v = r.view;
  return (
    <main style={box}>
      <h1>Your PowerHaul TMS company export</h1>
      <p>This is a copy of your company records and uploaded documents. The link works until <strong>{day(v.expiresAt)}</strong>.</p>
      <p>{v.partCount === 1 ? 'It comes as 1 part.' : `It comes as ${v.partCount} parts (${fmtBytes(v.totalBytes)} in total).`} {MANY_PARTS_NOTE}</p>
      <ul style={{ padding: 0, listStyle: 'none' }}>
        {v.parts.map((p) => (
          <li key={p.n} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(0,0,0,0.12)' }}>
            <a href={`/api/export-link/${encodeURIComponent(params.token)}/${p.n}`} rel="noreferrer nofollow" download>{p.name}</a>
            <span>{fmtBytes(p.bytes)}</span>
          </li>
        ))}
      </ul>
      {v.missingCount > 0 ? <p>{v.missingCount} uploaded {v.missingCount === 1 ? 'file is' : 'files are'} not included; manifest/not-included.csv inside the export lists {v.missingCount === 1 ? 'it' : 'them'}.</p> : null}
      <p>{RETENTION_NOTE}</p>
      <p>Anyone with this link can download the export, so do not share it.</p>
    </main>
  );
}
