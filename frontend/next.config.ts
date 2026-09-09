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
  // The landing page reads lib/showcase/*.yaml with fs at request time; make
  // sure the standalone build ships them (see lib/showcase/load.ts).
  outputFileTracingIncludes: {
    "/": ["./lib/showcase/*.yaml"],
  },
};

export default withNextIntl(nextConfig);
