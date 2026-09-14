import { NextResponse } from "next/server";
import { findNearbyFilmingIdeas } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Deliberately separate from /api/generate - this only runs when the user
// explicitly asks for it (see the "Find nearby ideas" button in page.js,
// shown once a result already exists), not bundled into every Generate
// click. findNearbyFilmingIdeas() does one sequential search per category
// (up to 9 for "all categories") in one call, so it's worth more time than
// the other pre-fetch endpoints but still opt-in. Raised from 120 for the
// same reason as /api/discovery - real "all categories" runs measured
// close to or past that ceiling, and a killed function returns Vercel's
// own non-JSON error page, which surfaces client-side as a raw
// "Unexpected token... is not valid JSON" instead of a real message.
export const maxDuration = 240;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, categories } = body;

  if (!location) {
    return NextResponse.json({ error: "location is required." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  const nearbyIdeas = await findNearbyFilmingIdeas({ idea, location, storyBeat, categories });
  if (!nearbyIdeas) {
    return NextResponse.json(
      { error: "Couldn't find nearby filming ideas right now. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ nearbyIdeas });
}
