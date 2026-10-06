import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import "./globals.css";

const degular = localFont({
  src: [
    { path: "../fonts/Degular-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/Degular-Medium.otf", weight: "500", style: "normal" },
    { path: "../fonts/Degular-Semibold.otf", weight: "600", style: "normal" },
    { path: "../fonts/Degular-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-degular",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reelarc Footage",
  description: "Drop a shoot's cards, get Premiere proxies automatically.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Every page renders per request, so each gets proxy.ts's fresh nonce (static pages can't carry one).
  await connection();
  return (
    <html lang="en" className={`${degular.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
