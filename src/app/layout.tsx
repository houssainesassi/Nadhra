import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";

const arabic = IBM_Plex_Sans_Arabic({ subsets: ["arabic", "latin"], weight: ["400", "500", "600"], variable: "--font-arabic", display: "swap" });

export const metadata: Metadata = {
  title: "بصيرة: مساعد البصر",
  description: "مساعد ذكي بالدارجة التونسية للمكفوفين وضعاف البصر: الكاميرا توصفلك اللي قدّامك وتجاوب على أسئلتك بالصوت.",
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
    <html lang="ar" dir="rtl" suppressHydrationWarning className={arabic.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
