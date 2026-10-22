import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Reference data (vendor master, POs, catalog, settings) and the recorded demo emails are read from the
  // test-data folder at run time; include them in the server bundle for Vercel.
  outputFileTracingIncludes: {
    "/*": ["./zamp-ps1-test-data-v2.1/test-data/**/*"],
    "/api/**": ["./zamp-ps1-test-data-v2.1/test-data/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
