// Shared by middleware.js (edge runtime) and the login API route, so both use
// only Web Crypto - no Node-only APIs - to stay edge-compatible.
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const AUTH_COOKIE = "www_auth";
