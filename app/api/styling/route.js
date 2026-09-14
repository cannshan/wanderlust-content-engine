import { NextResponse } from "next/server";
import { suggestStyling } from "../../../lib/claude";
import { checkBudget } from "../../../lib/budget";

// Platform-agnostic (what to wear doesn't change based on which app the
// video goes to), so - same reasoning as /api/restaurant-check and
// /api/location-search - this runs once per "Generate" click rather than
// once per selected platform, called only when the user opts in.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  // Silently returns null on a budget block, same as this optional
  // pre-fetch already does whenever the real call fails for any other
  // reason - see the identical comment in /api/location-search.
  const budget = await checkBudget();
  if (!budget.ok) return NextResponse.json({ stylingTip: null });

  const stylingTip = await suggestStyling(idea, location, storyBeat);
  return NextResponse.json({ stylingTip });
}
