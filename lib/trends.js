// Live "what's trending" lookup via Apify (a third-party scraping platform that
// turns TikTok's own public Creative Center trend pages into structured data).
// TikTok has no official trend/hashtag API for commercial or creator use - its
// Research API is restricted to academic institutions - so this is the realistic
// "automated" option. It degrades gracefully: if no Apify actor is configured,
// or the request fails, callers get an empty result and fall back to
// Claude's own knowledge of proven hashtag patterns instead of crashing.
//
// Setup: pick an actor from https://apify.com/store?search=tiktok+hashtag
// (e.g. "TikTok Hashtag Trends Scraper & Breakout Radar"), set APIFY_ACTOR_ID
// to its id (format: username~actor-name) and APIFY_API_TOKEN to your token.
// Actor input schemas vary - APIFY_INPUT_FIELD lets you match whatever field
// name that actor expects for a search term without touching code.

const APIFY_TIMEOUT_MS = 25000;

export async function getTrendingHashtags(query) {
  const token = process.env.APIFY_API_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID;

  if (!token || !actorId) {
    return { source: "none", hashtags: [] };
  }

  const inputField = process.env.APIFY_INPUT_FIELD || "searchTerms";
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(
    actorId
  )}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [inputField]: [query] }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { source: "error", hashtags: [], error: `Apify returned ${res.status}` };
    }

    const items = await res.json();
    const hashtags = parseHashtagsFromItems(items).slice(0, 15);
    return { source: "apify", hashtags };
  } catch (err) {
    return { source: "error", hashtags: [], error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// Different actors name fields differently - check a handful of common shapes
// rather than assuming one exact schema.
function parseHashtagsFromItems(items) {
  if (!Array.isArray(items)) return [];

  const out = [];
  for (const item of items) {
    const name =
      item.hashtagName ||
      item.hashtag ||
      item.name ||
      item.title ||
      item.challengeName ||
      item.tag;
    if (!name) continue;

    const tag = String(name).replace(/^#/, "").trim();
    if (!tag) continue;

    out.push({
      tag: `#${tag}`,
      posts: item.postCount ?? item.videoCount ?? item.posts ?? null,
      views: item.viewCount ?? item.views ?? null,
    });
  }
  return out;
}
