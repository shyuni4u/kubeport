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
  // Security headers (HSTS, nosniff, Referrer-Policy, CSP) are set in proxy.ts
  // from lib/security-headers.ts, not in `headers()` here: this file's headers
  // are baked into the build, and the chart has to be able to change them at
  // install time (#80). Do not add them back here too — both would apply.
  // The landing page reads lib/showcase/*.yaml with fs at request time; make
  // sure the standalone build ships them (see lib/showcase/load.ts).
  outputFileTracingIncludes: {
    "/": ["./lib/showcase/*.yaml"],
  },
};

export default withNextIntl(nextConfig);
