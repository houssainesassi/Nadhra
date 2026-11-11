import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic, Inter } from "next/font/google";
import "./globals.css";

// Inter for the English interface, IBM Plex Sans Arabic for everything the assistant says.
const latin = Inter({ subsets: ["latin"], variable: "--font-latin", display: "swap" });
const arabic = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600"], variable: "--font-arabic", display: "swap" });

const DESCRIPTION = "A voice assistant for blind and visually impaired people. It describes what the camera sees and answers spoken questions in Tunisian Arabic.";

export const metadata: Metadata = {
  title: "Nadhra: vision assistant",
  description: DESCRIPTION,
  applicationName: "Nadhra",
  appleWebApp: { capable: true, title: "Nadhra", statusBarStyle: "black-translucent" },
  openGraph: { type: "website", siteName: "Nadhra", title: "Nadhra (نظرة): vision assistant", description: DESCRIPTION },
  twitter: { card: "summary", title: "Nadhra (نظرة): vision assistant", description: DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#09090b",
};

// Applies the saved theme before paint. Dark unless the user chose light.
// The text size too, so large text doesn't jump in after the page has drawn.
const themeScript = `(function(){var d=document.documentElement,t='dark';try{t=localStorage.getItem('theme')==='light'?'light':'dark';var s=JSON.parse(localStorage.getItem('assistant.settings')||'{}').textScale;if(typeof s==='number'&&s>=1&&s<=2)d.style.setProperty('--text-scale',String(s))}catch(e){}d.dataset.theme=t})()`;

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
