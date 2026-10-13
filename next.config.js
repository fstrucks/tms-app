/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return ['/docs', '/doc', '/document'].map((source) => ({ source, destination: '/documents', permanent: true }));
  },
};

module.exports = nextConfig;
