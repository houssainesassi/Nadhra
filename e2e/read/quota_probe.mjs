// Prints the HTTP status of one tiny request to each reading model: 429 means the daily free quota is spent.
import { readFileSync } from "node:fs";
const key = readFileSync(".env.local", "utf8").match(/^GEMINI_API_KEY=(.*)$/m)[1].trim();
for (const m of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"]) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with: ok" }] }], generationConfig: { maxOutputTokens: 5 } }) });
  console.log(m, r.status);
}
