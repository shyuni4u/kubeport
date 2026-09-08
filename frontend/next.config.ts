import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  // The landing page reads lib/showcase/*.yaml with fs at request time; make
  // sure the standalone build ships them (see lib/showcase/load.ts).
  outputFileTracingIncludes: {
    "/": ["./lib/showcase/*.yaml"],
  },
};

export default withNextIntl(nextConfig);
