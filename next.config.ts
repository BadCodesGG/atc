import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/csp";

const nextConfig: NextConfig = {
  // The route indicator sits over the legend in the bottom-left corner.
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders({ dev: process.env.NODE_ENV === "development" }) }];
  },
};

export default nextConfig;
