import { NextResponse } from "next/server";
import { findTagSuggestions } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// "Who to tag" on the Content tab: researches which accounts are worth
// tagging for a repost (venue, real parent brand, tourism board, feature
// accounts), then checks each handle against the owner's own website
// server-side - see findTagSuggestions in lib/claude.js. Runs once per
// post, not per platform: the same accounts apply wherever it's posted,
// and the result carries both Instagram and TikTok handles.
//
// One no-search Claude call plus a website fetch per suggested account.
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, restaurantName, footageContext, description } = body;

  if (!idea || !location) {
    return NextResponse.json({ error: "Idea and location are both required." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  try {
    const result = await findTagSuggestions({
      idea,
      location,
      storyBeat,
      restaurantName,
      footageContext,
      description,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
