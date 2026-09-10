import { NextResponse } from "next/server";
import { getTrendingHashtags } from "../../../lib/trends";
import { generatePost } from "../../../lib/claude";

// Web search adds a real round trip on top of generation. Live testing hit
// the 60s ceiling itself (request killed mid-flight, returning an HTML
// error page the client can't parse as JSON) on a run that used extra
// search rounds - 120s gives real headroom for that without much downside
// (Vercel bills for actual duration, not the ceiling).
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, notes, lengthSeconds, platform } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  const resolvedPlatform = platform === "instagram" ? "instagram" : "tiktok";
  const resolvedLength = lengthSeconds === 30 ? 30 : 60;
  const trendResult = await getTrendingHashtags(
    `${idea} ${location} ${resolvedPlatform} ${notes || ""}`.trim()
  );

  try {
    const { usedWebSearch, ...result } = await generatePost({
      idea,
      location,
      storyBeat,
      notes,
      liveTrends: trendResult.hashtags,
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
