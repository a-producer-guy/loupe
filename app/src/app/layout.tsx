import type { Metadata, Viewport } from "next";
import { Courier_Prime, Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
// The script in the cutting room is set like a screenplay.
const courierPrime = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-script", display: "swap" });

export const metadata: Metadata = {
  title: "Loupe · You shot it. Loupe cuts it.",
  description: "The assistant editor for narrative film. Drop your scene and script; Loupe watches every take, picks the best reads and cuts the scene in 5 to 10 minutes, with a reason for every shot.",
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
