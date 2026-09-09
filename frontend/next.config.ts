import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  // Nothing in the app imports next/image, but /_next/image is served anyway
  // and is reachable without a session — the proxy only guards page routes.
  // That endpoint was the unauthenticated RCE in GHSA-2xp9-vwfh-vxw4 (fixed by
  // the next 16.3.4 bump in this change). Turning the optimizer off removes the
  // route entirely, so the next advisory against it doesn't reach us at all.
  // Revisit if a page ever starts using next/image.
  images: { unoptimized: true },
  // Don't advertise the framework.
  poweredByHeader: false,
  // The BFF terminates every external request, so this is the one place that
  // covers pages, /api/auth/* and /api/v1/* alike (#50).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Two years, matching the preload-list requirement. Safe here because
          // every host this chart serves (app + dex) is HTTPS-only.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // frame-ancestors rather than X-Frame-Options: it is the CSP-era
          // spelling and lets a future policy extend the same header. Keeps the
          // login screen and the demo-start buttons out of foreign iframes.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  // The landing page reads lib/showcase/*.yaml with fs at request time; make
  // sure the standalone build ships them (see lib/showcase/load.ts).
  outputFileTracingIncludes: {
    "/": ["./lib/showcase/*.yaml"],
  },
};

export default withNextIntl(nextConfig);
