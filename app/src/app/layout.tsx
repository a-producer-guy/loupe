import type { Metadata, Viewport } from "next";
import { Courier_Prime, Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
// The script in the cutting room is set like a screenplay.
const courierPrime = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-script", display: "swap" });

export const metadata: Metadata = {
  title: "Loupe · Direct your edit",
  description: "Drop your scene. Loupe watches every take, lines it up with your script and hands you a first cut, with a reason for every shot.",
  // Not ready for search engines until launch.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#f6f6f3", colorScheme: "light" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Every page renders per request, so each gets proxy.ts's fresh nonce (static pages can't carry one).
  await connection();
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${courierPrime.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
