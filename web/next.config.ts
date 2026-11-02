import type { NextConfig } from 'next';

// The browser only ever talks to this app's own origin. /api/* is forwarded to the API, so the
// session cookie is first-party and no CORS setup is needed. In AWS, CloudFront can do the same
// forwarding instead (path /api/* -> the API's load balancer) and this rewrite is then unused.
// API_ORIGIN is read when the app is built.
const apiOrigin = (process.env.API_ORIGIN ?? 'http://localhost:4000').replace(/\/$/, '');

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          // Location is used only when someone presses Check in or Check out.
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
        ],
      },
    ];
  },
};

export default config;
