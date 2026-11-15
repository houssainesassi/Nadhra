import type { MetadataRoute } from "next";

// Lets Android and iOS add Nadhra to the home screen under its own name.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nadhra (نظرة): vision assistant",
    short_name: "Nadhra",
    description: "A voice assistant for blind and visually impaired people. It describes what the camera sees and answers spoken questions in Tunisian Arabic.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    lang: "ar-TN",
    // The mark stays inside the 80% safe circle, so the PNGs double as maskable icons.
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
