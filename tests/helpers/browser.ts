// Headers a real page sends to the API routes: its own Origin and a valid session cookie.
// A fresh session each time, so per-session limits don't leak between tests.
import { issueSessionToken, SESSION_COOKIE } from "../../src/lib/server/session.ts";

export const browserHeaders = (host = "app.test"): Record<string, string> => ({
  host,
  origin: `http://${host}`,
  cookie: `${SESSION_COOKIE}=${issueSessionToken().token}`,
});
