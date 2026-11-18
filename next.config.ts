import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Everything the page loads comes from this site, except the live conversation's WebSocket to
// Gemini. 'unsafe-inline' scripts: Next's own inline scripts and the theme script in layout.tsx
// (a nonce would make every page dynamic). 'wasm-unsafe-eval': the on-device detector (MediaPipe).
// blob: scripts: the microphone's AudioWorklet in the live conversation (src/lib/live/audioIO.ts).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // OpenStreetMap tiles, only for the optional map in Location & directions.
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' wss://generativelanguage.googleapis.com${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Browsers only honour it over https; a year, without preload (that is a separate decision).
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // The assistant needs the camera and microphone (the browser still asks the user). Location: for
  // the Emergency page (put only into a message the user sends, never sent to this server), and,
  // after its own spoken consent, for Location & directions (sent through this server to the
  // OpenStreetMap services; see src/lib/server/geo.ts).
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/mediapipe/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=604800" }] },
    ];
  },
};

export default nextConfig;
