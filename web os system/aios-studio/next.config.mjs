/** @type {import('next').NextConfig} */
const apiOrigin = process.env.AIOS_API_ORIGIN || 'http://127.0.0.1:8700';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/mcp/:path*', destination: `${apiOrigin}/mcp/:path*` },
    ];
  },
};

export default nextConfig;
