import type { Metadata, Viewport } from "next";

import { DatabaseBanner } from "@/components/DatabaseBanner";
import { ServiceWorker } from "@/components/ServiceWorker";
import { Bitter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Slab serif for display type, monospace for every label and number — the two
// voices the design runs on.
const displaySerif = Bitter({
  variable: "--font-display-serif",
  subsets: ["latin"],
  weight: ["600", "700"],
});

const monoFace = JetBrains_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "PukaGolf",
  description: "Live scoring for a golf league.",
  applicationName: "PukaGolf",
  // Installed on iOS it runs without browser chrome, so the status bar has to
  // be told to sit over the header's own colour rather than a white strip.
  appleWebApp: {
    capable: true,
    title: "PukaGolf",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/** themeColor belongs to the viewport export, not metadata. */
export const viewport: Viewport = {
  themeColor: "#1d3521",
  // The app is a scorecard held in one hand; pinch-zoom stays available, but
  // the phone must not zoom the page just because a score input took focus.
  initialScale: 1,
  width: "device-width",
  viewportFit: "cover",
};

const SUNLIGHT_SCRIPT =
  'try{if(localStorage.getItem("pukagolf:sunlight")==="1")document.documentElement.setAttribute("data-sunlight","")}catch(e){}';

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${displaySerif.variable} ${monoFace.variable} h-full antialiased`}
      // The script below may add data-sunlight before React hydrates.
      suppressHydrationWarning
    >
      <head>
        {/*
          Sunlight mode, applied before the first paint so the page never
          flashes the normal palette first. Same key as SunlightToggle.
        */}
        <script dangerouslySetInnerHTML={{ __html: SUNLIGHT_SCRIPT }} />
      </head>
      {/*
        min-w-0 matters: flex items refuse to shrink below their content, so
        without it a wide leaderboard stretches the page instead of scrolling
        inside its own container.
      */}
      <body className="flex min-h-full min-w-0 flex-col">
        <ServiceWorker />
        <DatabaseBanner />
        {children}
      </body>
    </html>
  );
}
