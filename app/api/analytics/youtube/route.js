import { NextResponse } from "next/server";
import { fetchYouTubeAnalytics } from "../../../../lib/analytics";

// GET, not POST - nothing to send, the channel is fixed. Unlike Instagram
// and TikTok, YouTube's list + view counts are both readable via a plain
// server fetch (see lib/analytics.js), so this can genuinely run live on
// every Dashboard visit - nothing to persist, nothing that needs Claude to
// browse and seed it.
export async function GET() {
  try {
    const posts = await fetchYouTubeAnalytics(20);
    return NextResponse.json({ posts });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
