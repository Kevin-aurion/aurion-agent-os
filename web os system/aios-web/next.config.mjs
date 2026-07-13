/** @type {import('next').NextConfig} */
const API = process.env.AIOS_API_ORIGIN || 'http://127.0.0.1:8700';
const nextConfig = {
  reactStrictMode: true,
  // Proxy API + WS upgrade to the local backend so the browser talks same-origin.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};
export default nextConfig;
