import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic, Inter } from "next/font/google";
import "./globals.css";

// Inter for the English interface, IBM Plex Sans Arabic for everything the assistant says.
const latin = Inter({ subsets: ["latin"], variable: "--font-latin", display: "swap" });
const arabic = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600"], variable: "--font-arabic", display: "swap" });

export const metadata: Metadata = {
  title: "Basira: vision assistant",
  description: "A voice assistant for blind and visually impaired people. It describes what the camera sees and answers spoken questions in Tunisian Arabic.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#09090b",
};

// Applies the saved theme before paint. Dark unless the user chose light.
const themeScript = `(function(){var t='dark';try{t=localStorage.getItem('theme')==='light'?'light':'dark'}catch(e){}document.documentElement.dataset.theme=t})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning className={`${latin.variable} ${arabic.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
