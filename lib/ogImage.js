// Plain server-side fetch of a page's own declared preview image
// (og:image, falling back to twitter:image) - the same technique any
// link-preview generator (Slack, iMessage, Discord) uses. Deliberately
// NOT going through Claude's web_fetch tool: live testing for the
// Discovery tab's "Clothes to Wear" links showed Claude could read the
// exact right product page (it even quoted a real price straight off
// one) and still not surface a usable image URL from it - this bypasses
// that gap entirely by reading the page's own meta tags directly, no
// model involved.

const FETCH_TIMEOUT_MS = 6000;
// og:image is virtually always declared in <head>, which comes first -
// so there's no need to download a whole page, just enough of it.
const MAX_BYTES = 300_000;

// Not a full SSRF hardening pass (this app's threat model is a small,
// trusted team, and these URLs come from Claude's own search results,
// not raw user input) - just cheap insurance against an obviously wrong
// target before spending a server-side fetch on it.
function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local")) return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function fetchOgImage(pageUrl) {
  if (!isSafeUrl(pageUrl)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; WanderlustLinkPreview/1.0)",
        accept: "text/html",
      },
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytesRead = 0;
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});

    // Attribute order in the wild varies (property-then-content is more
    // common, but not universal), so both orders are checked.
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    const twitterMatch =
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);

    const raw = ogMatch?.[1] || twitterMatch?.[1];
    if (!raw) return null;

    // og:image content is sometimes a relative path, not an absolute URL.
    const resolved = new URL(raw, pageUrl).toString();
    if (!isSafeUrl(resolved)) return null;
    // A handful of sites declare a plain http:// og:image even though the
    // page itself is https. That image would get mixed-content blocked in
    // a real browser anyway, and separately, Claude's vision endpoint
    // rejects non-https image URLs outright (400) - so treat it the same
    // as no image at all rather than surfacing a link the app can't use.
    if (new URL(resolved).protocol !== "https:") return null;
    return resolved;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
