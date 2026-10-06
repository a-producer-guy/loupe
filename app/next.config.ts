import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/lib/security";

const nextConfig: NextConfig = {
  // The app is self-contained in this folder; don't go looking in parent folders.
  turbopack: { root: __dirname },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // The live site has one address. Vercel's own *.vercel.app addresses for it send people there.
  async redirects() {
    if (process.env.VERCEL_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "(?<vercel>.+)\\.vercel\\.app" }],
        destination: `${process.env.APP_URL ?? "https://footage.reelarc.com"}/:path*`,
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
