import { NextResponse } from "next/server";
import { searchForPlace } from "../../../lib/claude";
import { parseSocialLink, fetchSocialPost } from "../../../lib/socialLink";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Powers the Planning tab's own search bar - a direct free-text lookup for
// one specific restaurant/hike/place, separate from Discovery's broad
// category search. Fires only when the user submits the search, never
// automatically. A pasted TikTok/Instagram link instead reads that post's
// caption (free, see lib/socialLink.js) and finds the place it's about.
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { query } = body;
  if (!query || !query.trim()) {
    return NextResponse.json({ error: "query is required." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  // A link that can't be read stops here, before any paid search - a
  // search on the bare URL would only guess.
  const link = parseSocialLink(query);
  let sourcePost = null;
  if (link) {
    sourcePost = await fetchSocialPost(link);
    if (!sourcePost) {
      return NextResponse.json(
        {
          error: `Couldn't read that ${link.platform === "tiktok" ? "TikTok" : "Instagram"} post - it may be private or deleted. Try typing the place's name instead.`,
        },
        { status: 422 }
      );
    }
  }

  const places = await searchForPlace({ query, sourcePost });
  if (places === null) {
    return NextResponse.json({ error: "Couldn't search for that. Try again." }, { status: 500 });
  }

  // The post itself rides along so the results can show what was read
  // ("From @handle's TikTok") - she can check the right post was used.
  return NextResponse.json({
    places,
    sourcePost: sourcePost
      ? {
          platform: sourcePost.platform,
          url: sourcePost.url,
          author: sourcePost.author,
          caption: sourcePost.caption.slice(0, 280),
          thumbnailUrl: sourcePost.thumbnailUrl,
        }
      : null,
  });
}
