import sharp from "sharp";
import { isSafeUrl } from "../../../lib/ogImage";

// Card photos, served through here instead of straight from each
// business's website (see PlaceThumb.js). Their sites send full-size
// originals - often 2,000+ px and several MB - and some tell browsers to
// keep them only 15 minutes, so a phone re-downloaded them every time a
// card came back on screen. This fetches the original once, shrinks it to
// card size as WebP, and marks the result cacheable for a year (the URL
// never changes for a given photo + width), so the browser and Vercel's
// CDN keep it and it's instant after the first view.

const FETCH_TIMEOUT_MS = 10000;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;
// Only the widths PlaceThumb asks for - a fixed set keeps this from being
// used to generate arbitrary sizes.
const WIDTHS = new Set([160, 720]);
const USER_AGENT = "Mozilla/5.0 (compatible; WanderlustLinkPreview/1.0)";
const CACHE_FOREVER = "public, max-age=31536000, s-maxage=31536000, immutable";

function fail(status) {
  // Short cache on failures - a flaky site shouldn't leave a card blank
  // for a year.
  return new Response(null, { status, headers: { "cache-control": "public, max-age=300" } });
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const source = searchParams.get("u");
  const width = Number(searchParams.get("w"));
  if (!source || !WIDTHS.has(width) || !isSafeUrl(source) || !source.startsWith("https://")) return fail(400);

  // Redirects are followed by hand so every hop gets the same safety check
  // as the original URL (Wikimedia's photo links always redirect once).
  let res;
  let url = source;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "image/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      url = new URL(location, url).toString();
      if (hop >= MAX_REDIRECTS || !isSafeUrl(url) || !url.startsWith("https://")) return fail(502);
    }
  } catch {
    return fail(502);
  }
  const type = res.headers.get("content-type") || "";
  // SVGs are refused outright: they're rarely photos, and rasterizing
  // untrusted SVG is the riskiest thing an image library does.
  if (!res.ok || !type.startsWith("image/") || type.includes("svg")) return fail(502);
  if (Number(res.headers.get("content-length") || 0) > MAX_SOURCE_BYTES) return fail(413);

  const input = Buffer.from(await res.arrayBuffer());
  if (input.length > MAX_SOURCE_BYTES) return fail(413);

  try {
    const output = await sharp(input, { limitInputPixels: 50_000_000 })
      .rotate() // honor phone-photo EXIF orientation
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 74 })
      .toBuffer();
    return new Response(output, {
      headers: { "content-type": "image/webp", "cache-control": CACHE_FOREVER },
    });
  } catch {
    return fail(502);
  }
}
