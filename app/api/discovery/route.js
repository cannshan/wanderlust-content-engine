import { NextResponse } from "next/server";
import { findDiscoveryIdeas } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Same shape as /api/nearby-ideas - opt-in, on-demand, not bundled into
// any other click - but not anchored to a primary idea. Up to 9 sequential
// search passes for "all categories" (see findDiscoveryIdeas) routinely
// measured at 90-100+ seconds live, sometimes more - the previous 120s
// ceiling was too tight and real runs were hitting it, which kills the
// function mid-response and returns Vercel's own plain-text/HTML error
// page instead of JSON. That's what a raw "Unexpected token 'A', 'An
// error o...' is not valid JSON" in the browser actually was - not a
// parsing bug, a timeout. Raised to match the other genuinely-slow
// multi-search endpoints (generate, reel-edit-plan, planning research).
export const maxDuration = 240;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { location, categories, focus } = body;

  if (!location) {
    return NextResponse.json({ error: "location is required." }, { status: 400 });
  }

  // Not currently enforced (see ENFORCE_WEEKLY_BUDGET in lib/budget.js) -
  // wired up ahead of needing it for real per-account billing.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  const discoveryIdeas = await findDiscoveryIdeas({ location, categories, focus });
  if (!discoveryIdeas) {
    return NextResponse.json(
      { error: "Couldn't find things to do there right now. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ discoveryIdeas });
}
