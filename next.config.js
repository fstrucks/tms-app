/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Public site's "Sign in" link (app/site). Default: the current production app.
  env: { NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'https://tms-app-two-pi.vercel.app' },
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
    // Belt and braces: make sure the pdfjs worker ships with the packet routes (see packetPdfText.js).
    outputFileTracingIncludes: { '/api/packets/**': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'], '/api/inbound/**': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'] },
  }, // load pdfjs from node_modules on the server (no bundling)
  async redirects() {
    return ['/docs', '/doc', '/document'].map((source) => ({ source, destination: '/documents', permanent: true }));
  },
};

module.exports = nextConfig;
