import './globals.css';

export const metadata = {
  title: 'MemBridge — shared AI memory for teams',
  description:
    'See what every AI coding tool on your team did — who asked what, which files changed — without installing anything.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
