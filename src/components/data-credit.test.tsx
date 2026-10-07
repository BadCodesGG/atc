import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataCredit } from "./chrome";

describe("DataCredit", () => {
  const html = renderToStaticMarkup(<DataCredit />);

  it("credits the aircraft feeds, linked to their home pages", () => {
    expect(html).toContain('href="https://adsb.lol"');
    expect(html).toContain("(ODbL)");
    expect(html).toContain('href="https://adsb.fi"');
  });

  it("credits OpenStreetMap contributors for the airport layouts, linked to its copyright page", () => {
    expect(html).toMatch(
      /<a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<span class="hidden sm:inline"> contributors<\/span><\/a>/,
    );
  });

  it("keeps every source named on a phone, where the labels drop", () => {
    const phone = html.replace(/<span class="hidden sm:inline">[^<]*<\/span>/g, "");
    expect(phone).toContain(">adsb.lol</a>");
    expect(phone).toContain(">adsb.fi</a>");
    expect(phone).toContain(">OpenStreetMap</a>");
  });
});
