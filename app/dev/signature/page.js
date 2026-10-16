// QA-only route for the standalone SignaturePad (PR #61). 404 in production (VERCEL_ENV=production);
// works on Vercel previews and locally. Server component so VERCEL_ENV is read at request time.
import { notFound } from 'next/navigation';
import SignatureQA from './SignatureQA';

export const dynamic = 'force-dynamic';

export default function Page() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <SignatureQA />;
}
