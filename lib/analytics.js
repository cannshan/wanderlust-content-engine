// Pulls real post performance (views/likes/comments) for the Dashboard tab.
//
// This is NOT the official platform APIs - no OAuth, no developer app, no
// API keys. It reads the same public metadata a platform serves to any
// crawler/bot for link-preview purposes (og:description, embedded
// server-rendered JSON) - the same mechanism that got the 15 real sample
// captions in voiceProfile.js in the first place. That means it can break
// if a platform changes its page format, and it's explicitly NOT an
// officially supported integration - there's no contract guaranteeing this
// keeps working. Every function here throws a plain, specific error on
// failure rather than silently returning zeros, so a broken scrape is
// visible instead of looking like a real (bad) day of stats.
//
// Per-platform reality, confirmed by live testing against the real
// accounts before building this:
// - YouTube: both the last-20 list AND view counts are readable from a
//   plain server-side fetch of the channel's Shorts shelf (server-rendered
//   into the page for anyone, no JS execution needed). Likes/comments
//   are NOT readable this way - views only. Cheap enough to fetch live on
//   every Dashboard visit, so it's never persisted.
// - Instagram & TikTok: an individual POST's exact stats are readable via
//   plain fetch once you have its URL (og:description for Instagram,
//   embedded JSON for TikTok). The post LIST is different - it's loaded by
//   client-side JavaScript after the page loads, so it's invisible to a
//   plain server fetch (no JS execution) regardless of login state, but
//   visible to any real browser session, logged in or not. Since Vercel's
//   serverless functions can only do plain fetches, there's no way for the
//   deployed site itself to discover these lists - that part has to be
//   done from an actual browser session (see the accompanying script this
//   file is paired with) and the results persisted to Supabase for the
//   Dashboard tab to read.

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Instagram serves its full link-preview metadata to a recognized crawler
// UA even more reliably than a browser UA - this is Meta's own crawler
// identity for link unfurling, so it's the most honest UA to send for
// exactly this use case.
const CRAWLER_UA = "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)";

const YOUTUBE_SHORTS_URL = "https://www.youtube.com/@WineWildernessWanderlust/shorts";

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// "31K" -> 31000, "1.2M" -> 1200000, "503" -> 503. Platforms round large
// counts in this exact metadata, so anything above ~10K is an estimate,
// not an exact figure - fine for a relative performance chart, not for
// precise analytics.
function parseRoundedCount(str) {
  if (!str) return null;
  const m = str.replace(/,/g, "").trim().match(/^([\d.]+)\s*([KMB]?)$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// "985" -> 985, "1.1 thousand" -> 1100, "2.4 million" -> 2400000. YouTube
// switches from exact digits to this "N.N thousand/million" phrasing above
// ~1000 - live testing found the original digits-only regex left that
// boundary unmatched, so the title's non-greedy capture kept consuming
// forward past it looking for a match, swallowing unrelated JSON text from
// later in the page into the title.
function parseYouTubeViewCount(raw) {
  const cleaned = raw.replace(/,/g, "").trim();
  const m = cleaned.match(/^([\d.]+)(?:\s+(thousand|million))?$/i);
  if (!m) return null;
  const mult = { thousand: 1e3, million: 1e6 }[m[2]?.toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// The Shorts shelf embeds a `ytInitialData` JSON blob server-side (so the
// page still works before any JS runs) containing every short's videoId
// paired with an accessibilityText like "<title>, 318 views - play Short"
// (or "<title>, 1.1 thousand views - play Short" above ~1000). Pulling
// videoId+accessibilityText together in one regex (rather than two separate
// passes zipped by index) keeps each pair correctly matched even if the two
// ever appear in a different relative order.
export async function fetchYouTubeAnalytics(limit = 20) {
  const res = await fetch(YOUTUBE_SHORTS_URL, { headers: { "user-agent": CHROME_UA } });
  if (!res.ok) {
    throw new Error(`YouTube returned ${res.status} - the channel page may be temporarily unavailable.`);
  }
  const html = await res.text();

  const re =
    /"videoId":"([a-zA-Z0-9_-]{11})".*?"accessibilityText":"(.+?), ([\d,]+(?:\.\d+)?(?:\s+(?:thousand|million))?) views - play Short"/gs;
  const seen = new Set();
  const posts = [];
  let m;
  while ((m = re.exec(html)) && posts.length < limit) {
    const [, videoId, title, viewsRaw] = m;
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    posts.push({
      id: videoId,
      title: decodeHtmlEntities(title.trim()),
      views: parseYouTubeViewCount(viewsRaw),
      likes: null,
      comments: null,
      url: `https://www.youtube.com/shorts/${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/frame0.jpg`,
    });
  }

  if (posts.length === 0) {
    throw new Error("Couldn't find any Shorts on the channel page - YouTube may have changed its page format.");
  }
  return posts;
}

async function fetchInstagramPostStats(url) {
  const res = await fetch(url, { headers: { "user-agent": CRAWLER_UA } });
  if (!res.ok) {
    throw new Error(`Instagram returned ${res.status} for this link - it may be private, deleted, or wrong.`);
  }
  const html = await res.text();

  const descMatch = html.match(/<meta property="og:description" content="([^"]*)"/i);
  if (!descMatch) {
    throw new Error("Couldn't read this Instagram post's stats - it may be private, deleted, or Instagram changed its page format.");
  }
  const desc = decodeHtmlEntities(descMatch[1]);
  const imageMatch = html.match(/<meta property="og:image" content="([^"]*)"/i);

  const statsMatch = desc.match(/^([\d.,]+[KMB]?)\s*likes?(?:,\s*([\d.,]+[KMB]?)\s*comments?)?/i);
  const viewsMatch = desc.match(/^([\d.,]+[KMB]?)\s*views?/i);
  const dateMatch = desc.match(/on ([A-Za-z]+ \d{1,2}, \d{4})/);
  const captionMatch = desc.match(/:\s*"([\s\S]*)"\.?\s*$/);

  return {
    id: url,
    title: captionMatch ? decodeHtmlEntities(captionMatch[1]).split("\n")[0].slice(0, 80) : "Instagram post",
    views: viewsMatch ? parseRoundedCount(viewsMatch[1]) : null,
    likes: statsMatch ? parseRoundedCount(statsMatch[1]) : null,
    comments: statsMatch && statsMatch[2] ? parseRoundedCount(statsMatch[2]) : null,
    shares: null,
    date: dateMatch ? dateMatch[1] : null,
    url,
    thumbnail: imageMatch ? imageMatch[1] : null,
  };
}

async function fetchTikTokPostStats(url) {
  const res = await fetch(url, { headers: { "user-agent": CHROME_UA } });
  if (!res.ok) {
    throw new Error(`TikTok returned ${res.status} for this link - it may be private, deleted, or wrong.`);
  }
  const html = await res.text();

  const scriptMatch = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
  if (!scriptMatch) {
    throw new Error("Couldn't read this TikTok video's stats - it may be private, deleted, or TikTok changed its page format.");
  }

  let itemStruct;
  try {
    const data = JSON.parse(scriptMatch[1]);
    itemStruct = data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  } catch {
    throw new Error("Couldn't parse TikTok's page data for this link.");
  }
  if (!itemStruct) {
    throw new Error("TikTok didn't return video data for this link - double check it's a real, public video URL.");
  }

  const stats = itemStruct.stats || {};
  return {
    id: url,
    title: (itemStruct.desc || "TikTok video").split("\n")[0].slice(0, 80),
    views: typeof stats.playCount === "number" ? stats.playCount : null,
    likes: typeof stats.diggCount === "number" ? stats.diggCount : null,
    comments: typeof stats.commentCount === "number" ? stats.commentCount : null,
    shares: typeof stats.shareCount === "number" ? stats.shareCount : null,
    date: itemStruct.createTime ? new Date(Number(itemStruct.createTime) * 1000).toLocaleDateString() : null,
    url,
    thumbnail: itemStruct.video?.cover || null,
  };
}

export async function fetchPostStats(url) {
  if (/instagram\.com/i.test(url)) return fetchInstagramPostStats(url);
  if (/tiktok\.com/i.test(url)) return fetchTikTokPostStats(url);
  throw new Error(`Not a recognized Instagram or TikTok link: ${url}`);
}

// Runs every link's fetch independently (Promise.allSettled) so one bad
// or deleted link doesn't take down the whole refresh - a failed link
// comes back with an `error` field instead of stats, still shown in the
// UI rather than silently dropped.
export async function fetchManyPostStats(urls) {
  const results = await Promise.allSettled(urls.map((u) => fetchPostStats(u.trim())));
  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { url: urls[i].trim(), error: r.reason?.message || "Failed to fetch stats." }
  );
}
