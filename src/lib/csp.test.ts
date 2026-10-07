import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "./csp";

const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(" ") ?? [];

describe("the Content-Security-Policy", () => {
  const prod = contentSecurityPolicy();

  it("lets this site and the portfolio at badcodes.dev frame the app, and nothing else", () => {
    expect(prod).toContain("frame-ancestors 'self' https://badcodes.dev;");
    expect(directive(prod, "frame-ancestors")).toEqual(["'self'", "https://badcodes.dev"]);
  });

  it("allows eval only under next dev", () => {
    expect(prod).not.toContain("unsafe-eval");
    expect(directive(contentSecurityPolicy({ dev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("names every third party the browser itself fetches from, and no wildcard host", () => {
    expect(directive(prod, "connect-src")).toEqual(expect.arrayContaining(["https://tiles.openfreemap.org", "https://basemap.nationalmap.gov", "https://api.rainviewer.com", "https://*.rainviewer.com", "https://api.planespotters.net"]));
    expect(directive(prod, "img-src")).toEqual(expect.arrayContaining(["data:", "blob:", "https://*.plnspttrs.net", "https://*.planespotters.net", "https://*.rainviewer.com", "https://basemap.nationalmap.gov"]));
    expect(directive(prod, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(prod).not.toMatch(/(^|[ ;])\*([ ;]|$)/);
    expect(directive(prod, "object-src")).toEqual(["'none'"]);
  });
});

describe("the security headers", () => {
  const headers = securityHeaders();

  it("carry the policy, nosniff and a strict-origin-when-cross-origin referrer", () => {
    expect(headers).toEqual([
      { key: "Content-Security-Policy", value: contentSecurityPolicy() },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ]);
  });

  it("do not set X-Frame-Options, which cannot name the portfolio and would block its embed", () => {
    expect(headers.map((h) => h.key.toLowerCase())).not.toContain("x-frame-options");
  });
});
