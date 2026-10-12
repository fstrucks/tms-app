import './globals.css';
import AppNav from './components/AppNav';

export const metadata = {
  title: { default: 'PowerHaul TMS', template: '%s | PowerHaul TMS' },
  description: 'PowerHaul TMS: rate confirmations, loads, mileage, expenses and weekly numbers for owner-operators.',
  applicationName: 'PowerHaul TMS',
  appleWebApp: { title: 'PowerHaul TMS' },
  other: { 'mobile-web-app-capable': 'yes' },
};

export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AppNav />
        {children}
      </body>
    </html>
  );
}
