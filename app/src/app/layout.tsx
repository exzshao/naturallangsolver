import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "NLP Solver",
  description: "Describe a heads-up postflop poker spot in plain English and get a GTO strategy.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Light unless the saved choice is dark; the <head> script sets data-theme before paint.
    <html lang="en" className={`${plexMono.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
