import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * The app is one page: airports, flights and views are query and hash state on it, not routes, so the
 * sitemap lists that page alone. It draws live traffic, so there is no meaningful last-modified date.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: new URL("/", SITE_URL).href }];
}
