/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ['pdfjs-dist'] }, // load pdfjs from node_modules on the server (no bundling)
  async redirects() {
    return ['/docs', '/doc', '/document'].map((source) => ({ source, destination: '/documents', permanent: true }));
  },
};

module.exports = nextConfig;
