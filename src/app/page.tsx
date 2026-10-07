import type { Viewport } from "next";
import { AtcApp } from "@/components/atc-app";
import { airportFromParam } from "@/lib/airport-url";
import { readFilters } from "@/lib/filters";
import { THEMES, type ThemeKey, themeKey } from "@/lib/scene/theme";

/** `?theme=dark` opens on night ops and `?theme=satellite` on daylight, so a shot or a shared link is reproducible; anything else is light. */
async function themeOf(searchParams: PageProps<"/">["searchParams"]): Promise<ThemeKey> {
  return themeKey((await searchParams).theme);
}

/** The browser's own chrome takes the theme's page colour. */
export async function generateViewport({ searchParams }: PageProps<"/">): Promise<Viewport> {
  return { themeColor: THEMES[await themeOf(searchParams)].background };
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  // `?airport=dfw` opens on that airport; a missing or unlisted code opens Atlanta.
  return <AtcApp initialTheme={themeKey(params.theme)} initialAirport={airportFromParam(params.airport).code} initialFilters={readFilters(params)} />;
}
