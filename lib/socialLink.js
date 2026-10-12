// Reads the public caption of a TikTok or Instagram post from a pasted
// link, so the Planning search can find the place a post is about. No
// login, no API key, no cost:
// - TikTok: its public oEmbed endpoint (the same one any site uses to
//   embed a TikTok) returns the caption as `title`.
// - Instagram: the post page's own link-preview tags (og:title/
//   og:description), the same tags iMessage/Slack read for a preview.
//   Instagram's oEmbed needs a Meta app token, so it isn't used.
// Only these two hosts are ever fetched, so a pasted link can't point
// this server at anything else.

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600_000;
const PREVIEW_USER_AGENT = "Mozilla/5.0 (compatible; WanderlustLinkPreview/1.0)";

const TIKTOK_HOST = /^([a-z0-9-]+\.)?tiktok\.com$/i;
const INSTAGRAM_HOST = /^([a-z0-9-]+\.)?instagram\.com$/i;

// The whole input has to be a single link - "lobster roll near
// https://..." stays a normal text search.
export function parseSocialLink(input) {
  const text = (input || "").trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.protocol = "https:";
  if (TIKTOK_HOST.test(url.hostname)) return { platform: "tiktok", url: url.toString() };
  if (INSTAGRAM_HOST.test(url.hostname)) return { platform: "instagram", url: url.toString() };
  return null;
}

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaContent(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, "i");
  const match = html.match(re);
  return match ? decodeEntities(match[1]).trim() : null;
}

async function readHead(url) {
  const res = await fetch(url, {
    headers: { "user-agent": PREVIEW_USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  while (bytes < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    html += decoder.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

async function fetchTikTok(url) {
  // Short share links (vm./vt.tiktok.com) redirect to the full video URL,
  // which is what oEmbed wants. A redirect off TikTok is refused.
  let videoUrl = url;
  if (!/\/video\/\d+|\/photo\/\d+/.test(new URL(url).pathname)) {
    const res = await fetch(url, {
      headers: { "user-agent": PREVIEW_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    res.body?.cancel().catch(() => {});
    if (!TIKTOK_HOST.test(new URL(res.url).hostname)) return null;
    videoUrl = res.url;
  }

  const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.title && !data?.author_name) return null;
  return {
    platform: "tiktok",
    url: videoUrl,
    author: data.author_url?.match(/@([^/?]+)/)?.[1] || data.author_name || null,
    caption: data.title || "",
    thumbnailUrl: data.thumbnail_url || null,
  };
}

async function fetchInstagram(url) {
  const html = await readHead(url);
  if (!html) return null;
  const title = metaContent(html, "og:title");
  const description = metaContent(html, "og:description");
  // og:description reads `32K likes, 530 comments - handle on July 21,
  // 2026: "caption..."` - the caption is the quoted part; og:title is
  // `Name on Instagram: "caption..."` as a fallback.
  const quoted = (s) => s?.match(/:\s*"([\s\S]*)"\s*\.?\s*$/)?.[1] || null;
  const caption = quoted(description) || quoted(title);
  if (!caption) return null;
  const author = description?.match(/-\s*([A-Za-z0-9._]+)\s+on\s+/)?.[1] || null;
  return {
    platform: "instagram",
    url,
    author,
    caption,
    thumbnailUrl: metaContent(html, "og:image"),
  };
}

// { platform, url, author, caption, thumbnailUrl } or null when the post
// is private, deleted, or the platform refused the request.
export async function fetchSocialPost(link) {
  try {
    const post = link.platform === "tiktok" ? await fetchTikTok(link.url) : await fetchInstagram(link.url);
    if (!post) return null;
    return { ...post, caption: post.caption.slice(0, 3000) };
  } catch (err) {
    console.error(`[socialLink] couldn't read ${link.platform} post:`, err.message);
    return null;
  }
}
