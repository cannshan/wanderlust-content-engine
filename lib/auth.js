// Shared by proxy.js (Next.js 16's replacement for middleware.js - same
// request-interception role, now Node.js runtime instead of edge) and the
// login API route. Kept to Web Crypto rather than Node-only APIs since that
// requirement predates the proxy.js rename and there's no reason to drop it.
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const AUTH_COOKIE = "www_auth";
