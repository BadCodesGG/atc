import { describe, expect, it, vi } from "vitest";
// next/font only exists inside the Next build; the layout needs it to load.
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "" });
  return { Albert_Sans: font, IBM_Plex_Mono: font, IBM_Plex_Sans_Condensed: font, Instrument_Sans: font };
});

import nextConfig from "../../next.config";
import { metadata } from "./layout";
import robots from "./robots";
import sitemap from "./sitemap";

describe("robots.txt", () => {
  it("blocks no path, so a rendering crawler can fetch the API routes the page draws from", () => {
    const rules = [robots().rules].flat();
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe("*");
    expect([rules[0].disallow ?? []].flat().filter((path) => path !== "")).toEqual([]);
  });

  it("points at the sitemap on the custom domain", () => {
    expect(robots().sitemap).toBe("https://atc.badcodes.dev/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  it("lists the one page, as its canonical link names it", () => {
    expect(metadata.alternates?.canonical).toBe("/");
    const canonical = new URL(String(metadata.alternates?.canonical), metadata.metadataBase!).href;
    expect(sitemap().map((entry) => entry.url)).toEqual([canonical]);
    expect(canonical).toBe("https://atc.badcodes.dev/");
  });
});

describe("noindex", () => {
  const noindexRules = async () =>
    ((await nextConfig.headers?.()) ?? []).filter((rule) => rule.headers.some((h) => h.key === "X-Robots-Tag" && h.value === "noindex"));

  it("keeps the API answers out of search results without blocking them", async () => {
    const api = (await noindexRules()).find((rule) => rule.source === "/api/:path*");
    expect(api).toBeDefined();
    expect(api!.has ?? []).toEqual([]);
    expect(api!.missing ?? []).toEqual([]);
  });

  it("is sent on every host except the custom domain", async () => {
    const hosts = (await noindexRules()).find((rule) => rule.source === "/:path*");
    expect(hosts?.missing).toEqual([{ type: "host", value: "atc.badcodes.dev" }]);
    expect(hosts?.has ?? []).toEqual([]);
  });
});
