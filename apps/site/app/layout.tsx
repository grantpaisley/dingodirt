import type { Metadata } from "next";
import { Big_Shoulders, Barlow } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const display = Big_Shoulders({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "700", "900"],
});

const body = Barlow({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "dingodirt — plan it, ride it, share it",
  description:
    "The home of Dingo Plan, Nav and Studio: plan routes on real trail data, follow them offline on the bars, and share packs with your mates.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
