import { NextResponse } from "next/server";
import { getTrendingHashtags } from "../../../lib/trends";
import { generatePost, checkRestaurantMenu } from "../../../lib/claude";

// generatePost() now retries up to 3x internally on a malformed/incomplete
// model response, so a single request can involve up to 3 full generation
// attempts (~30-60s each observed). 240s gives room for that worst case
// (Vercel bills for actual duration, not the ceiling).
export const maxDuration = 240;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, notes, lengthSeconds, platform, menuCheck: precomputedMenuCheck } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  const resolvedPlatform = ["instagram", "youtube"].includes(platform) ? platform : "tiktok";
  const resolvedLength = lengthSeconds === 30 ? 30 : 60;

  // The trend search is deliberately platform-specific (the query embeds
  // the platform name, since trending tags genuinely differ by platform),
  // so it still runs per-request here. The menu check is NOT platform-
  // specific - a restaurant's menu doesn't change based on which app it's
  // being posted to - so the caller (page.js) is expected to run it once
  // via /api/menu-check and pass the result in as `menuCheck`, shared
  // across every platform's request instead of repeating the same live
  // search per platform. Falling back to computing it here too, so this
  // endpoint still works standalone if menuCheck is never provided.
  const [trendResult, menuCheck] = await Promise.all([
    getTrendingHashtags(`${idea} ${location} ${resolvedPlatform} ${notes || ""}`.trim()),
    precomputedMenuCheck !== undefined
      ? Promise.resolve(precomputedMenuCheck)
      : checkRestaurantMenu(idea, location, storyBeat, notes),
  ]);

  console.log(
    `[generate] platform=${resolvedPlatform} trend_source=${trendResult.source} menu_check=${
      menuCheck ? `"${menuCheck.slice(0, 200)}${menuCheck.length > 200 ? "…" : ""}"` : "none/skipped"
    }`
  );

  try {
    const { usedWebSearch, ...result } = await generatePost({
      idea,
      location,
      storyBeat,
      notes,
      liveTrends: trendResult.hashtags,
      menuCheck,
      lengthSeconds: resolvedLength,
      platform: resolvedPlatform,
    });

    // Apify (pre-fetched) takes priority if it actually returned something;
    // otherwise Claude's own live web search; otherwise proven-pattern estimate.
    const trend_source =
      trendResult.source === "apify" && trendResult.hashtags.length > 0
        ? "apify"
        : usedWebSearch
        ? "web_search"
        : "estimated";

    return NextResponse.json({ ...result, trend_source, lengthSeconds: resolvedLength });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
