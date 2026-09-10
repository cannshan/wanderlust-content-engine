import { NextResponse } from "next/server";
import { getTrendingHashtags } from "../../../lib/trends";
import { generatePost } from "../../../lib/claude";

// Web search adds a real round trip on top of generation (~20-25s observed
// in testing) - give it headroom above Vercel's legacy serverless default.
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, businessTag, format, trendNotes, goal, platform } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  const resolvedPlatform = platform === "instagram" ? "instagram" : "tiktok";
  const trendResult = await getTrendingHashtags(`${idea} ${location} ${resolvedPlatform}`);
  const resolvedGoal = goal === "reach" ? "reach" : "monetize";

  try {
    const { usedWebSearch, ...result } = await generatePost({
      idea,
      location,
      storyBeat,
      businessTag,
      format,
      trendNotes,
      liveTrends: trendResult.hashtags,
      goal: resolvedGoal,
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

    return NextResponse.json({ ...result, trend_source, goal: resolvedGoal });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
