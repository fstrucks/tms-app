import './globals.css';
import ReportBugButton from './components/ReportBugButton';
import AppNav from './components/AppNav';
import WelcomeScreen from './components/WelcomeScreen';
import CompanyAddPrompt from './components/CompanyAddPrompt';
import NativeShell from './components/NativeShell';
import { THEME_INIT_SCRIPT, THEME_COLORS } from './lib/theme';

export const metadata = {
  title: { default: 'PowerHaul TMS', template: '%s | PowerHaul TMS' },
  description: 'PowerHaul TMS: rate confirmations, loads, mileage, expenses and weekly numbers for owner-operators.',
  applicationName: 'PowerHaul TMS',
  appleWebApp: { title: 'PowerHaul TMS' },
  other: { 'mobile-web-app-capable': 'yes' },
};

export const viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover', colorScheme: 'light dark',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: THEME_COLORS.light }, { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.dark }],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets data-theme before paint (no flash); see app/lib/theme.js */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <NativeShell />
        <ReportBugButton />
        <AppNav />
        <CompanyAddPrompt />
        <div className="app-container">{children}</div>
        <WelcomeScreen />
      </body>
    </html>
  );
}
