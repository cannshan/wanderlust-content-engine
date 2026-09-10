import { NextResponse } from "next/server";
import { getTrendingHashtags } from "../../../lib/trends";
import { generatePost } from "../../../lib/claude";

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, businessTag, format, trendNotes } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  const trendResult = await getTrendingHashtags(`${idea} ${location}`);

  try {
    const { usedWebSearch, ...result } = await generatePost({
      idea,
      location,
      storyBeat,
      businessTag,
      format,
      trendNotes,
      liveTrends: trendResult.hashtags,
    });

    // Apify (pre-fetched) takes priority if it actually returned something;
    // otherwise Claude's own live web search; otherwise proven-pattern estimate.
    const trend_source =
      trendResult.source === "apify" && trendResult.hashtags.length > 0
        ? "apify"
        : usedWebSearch
        ? "web_search"
        : "estimated";

    return NextResponse.json({ ...result, trend_source });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
