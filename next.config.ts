import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/csp";
import { SITE_URL } from "./src/lib/site";

const nextConfig: NextConfig = {
  // The route indicator sits over the legend in the bottom-left corner.
  devIndicators: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders({ dev: process.env.NODE_ENV === "development" }) },
      // The API answers are raw feed JSON: the page fetches them, so robots.txt leaves them open,
      // but they are not pages and stay out of search results.
      { source: "/api/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
      // The deployment also answers on its *.vercel.app aliases (and any other host pointed at it);
      // only the custom domain is indexed.
      { source: "/:path*", missing: [{ type: "host", value: new URL(SITE_URL).host }], headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
    ];
  },
};

export default nextConfig;
