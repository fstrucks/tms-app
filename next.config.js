/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
    // Belt and braces: make sure the pdfjs worker ships with the packet routes (see packetPdfText.js).
    outputFileTracingIncludes: {
      '/api/packets/**': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
      '/api/inbound/**': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
      '/privacy': ['./content/legal/privacy.md'],
      '/terms': ['./content/legal/terms.md'],
    },
  }, // load pdfjs from node_modules on the server (no bundling)
  async redirects() {
    return ['/docs', '/doc', '/document'].map((source) => ({ source, destination: '/documents', permanent: true }));
  },
};

module.exports = nextConfig;
