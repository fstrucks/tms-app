// Mileage moved inside Stats (Marc, Oct 17). Old links and the ELD import's /mileage?imported=… still work.
import { redirect } from 'next/navigation';
import { mileageRedirectUrl } from '../lib/statsViews';

export const dynamic = 'force-dynamic';

export default function Page({ searchParams }) {
  redirect(mileageRedirectUrl(searchParams));
}
