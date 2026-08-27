/** @type {import('next').NextConfig} */
const API = process.env.AIOS_API_ORIGIN || 'http://127.0.0.1:8700';
const nextConfig = {
  reactStrictMode: true,
  // Proxy REST API calls to the local backend. WebSocket upgrade routing is
  // handled by the deployment edge (Cloudflare ingress in production).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};
export default nextConfig;
