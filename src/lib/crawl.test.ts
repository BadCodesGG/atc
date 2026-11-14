import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

describe("robots.txt", () => {
  it("blocks nothing, so a rendering crawler can fetch the API routes the page draws from", () => {
    const rules = [robots().rules].flat();
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe("*");
    expect(rules[0].disallow ?? []).toEqual([]);
  });

  it("points at the sitemap on the custom domain", () => {
    expect(robots().sitemap).toBe("https://atc.badcodes.dev/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  it("lists the one page, on the custom domain", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual(["https://atc.badcodes.dev/"]);
  });

  it("matches the app's pages: src/app has the root page and no other page route", () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/^page\.(tsx?|jsx?)$/.test(entry.name)) pages.push(path.relative(path.join(process.cwd(), "src/app"), full));
      }
    };
    walk(path.join(process.cwd(), "src/app"));
    expect(pages).toEqual(["page.tsx"]);
  });
});
