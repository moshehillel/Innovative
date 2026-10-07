import type { Context } from "https://edge.netlify.com";

/**
 * Site-wide Basic auth for the Innovative Jerry dashboard.
 * Set DASHBOARD_PASSWORD in Netlify site env vars.
 */
export default async (request: Request, context: Context) => {
  const expectedPassword = Deno.env.get("DASHBOARD_PASSWORD");
  if (!expectedPassword) {
    return new Response("This dashboard is not configured yet.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (!isAuthorized(request.headers.get("authorization"), expectedPassword)) {
    return new Response("Authentication required.", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Innovative dashboard", charset="UTF-8"',
        "Content-Type": "text/plain",
      },
    });
  }

  return context.next();
};

function isAuthorized(header: string | null, expectedPassword: string): boolean {
  if (!header || !header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  // Username is ignored — shared password only.
  const password = decoded.slice(separatorIndex + 1);
  return timingSafeEqual(password, expectedPassword);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export const config = { path: "/*" };
