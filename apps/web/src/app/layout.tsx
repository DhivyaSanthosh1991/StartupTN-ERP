import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/public-sans/index.css';
import '@fontsource-variable/fraunces/index.css';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'StartupTN staff portal', template: '%s · StartupTN staff portal' },
  description: 'Attendance, leave, on-duty requests, approvals and employee records for StartupTN staff.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1b4fb3' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
