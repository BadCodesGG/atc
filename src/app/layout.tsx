import type { Metadata, Viewport } from "next";
import { Albert_Sans, IBM_Plex_Mono, IBM_Plex_Sans_Condensed, Instrument_Sans } from "next/font/google";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

/** The dark theme's type, as in the night ops mock: condensed sans for words, mono for data and controls. */
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  preload: false,
});
const plexCondensed = IBM_Plex_Sans_Condensed({
  variable: "--font-plex-condensed",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  preload: false,
});

/** The satellite theme's type, as in the daylight mock. */
const albertSans = Albert_Sans({
  variable: "--font-albert-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  preload: false,
});

const TITLE = "ATC: live airport traffic in 3D";
const DESCRIPTION = "Every aircraft at a busy US airport, live from ADS-B, on a 3D model of the airfield.";

/**
 * The share card is public/og.jpg, in the same style as the other badcodes.dev apps', so every link
 * unfurls as one family.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://atc.badcodes.dev"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", url: "/", siteName: "ATC", title: TITLE, description: DESCRIPTION, images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "ATC: live US airport traffic in 3D" }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.jpg"] },
};

export const viewport: Viewport = {
  themeColor: "#f4f3ef",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${plexCondensed.variable} ${plexMono.variable} ${albertSans.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
