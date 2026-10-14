// Sends the browser back to the login screen the moment the dashboard's login
// cookie is gone (cleared, expired, or a different browser profile) while
// the page is still open. proxy.js already redirects page loads, but an
// open page only makes /api/ calls, which it answers with a bare 401 -
// every tab would otherwise just fail quietly ("couldn't find these on
// the map", empty lists) until the page happened to be reloaded.
//
// Installed once, on import, by wrapping window.fetch: every tab calls
// fetch directly, so this covers all of them without touching each one.
// /api/login is skipped - its 401 means "wrong password", which the login
// form shows itself.

function isSignedOutResponse(input, res) {
  if (res.status !== 401) return false;
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input), window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith("/api/") && url.pathname !== "/api/login";
}

if (typeof window !== "undefined" && !window.__wwwSessionGuard) {
  window.__wwwSessionGuard = true;
  const originalFetch = window.fetch.bind(window);
  let redirecting = false;
  window.fetch = async (input, init) => {
    const res = await originalFetch(input, init);
    if (!redirecting && window.location.pathname !== "/login" && isSignedOutResponse(input, res)) {
      redirecting = true;
      // A full page load (not router.push), so no tab's half-loaded state
      // survives; the login form comes back here afterwards.
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    }
    return res;
  };
}
