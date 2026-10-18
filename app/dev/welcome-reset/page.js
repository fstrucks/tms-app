// QA-only: reset the signed-in user's welcome "seen" flag (PR #77). 404 in production (VERCEL_ENV=production);
// works on Vercel previews and locally. Server component so VERCEL_ENV is read at request time. No SQL.
import { notFound } from 'next/navigation';
import WelcomeResetQA from './WelcomeResetQA';

export const dynamic = 'force-dynamic';

export default function Page() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <WelcomeResetQA />;
}
