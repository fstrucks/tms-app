// QA-only preview of the Reviews tab. 404 in production. Fake shipper and receiver, no database.
import { notFound } from 'next/navigation';
import ReviewsPreview from './ReviewsPreview';

export const dynamic = 'force-dynamic';

export default function Page() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <ReviewsPreview />;
}
