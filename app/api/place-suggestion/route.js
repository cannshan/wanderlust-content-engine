import { NextResponse } from "next/server";
import { suggestForPlace } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Ad-hoc only - fires when a user clicks one of the three per-place
// buttons in DiscoveryTab (Clothes to Wear / Foodie-Explore Advice /
// Suggest Both), never automatically for every place in a result.
// Kept at 240 even though findStyleLinks (lib/claude.js) no longer makes
// a second Claude call to retry - it now sifts through up to 12 candidates
// from the one search, which is more fetch/classify work than before, so
// the margin stays generous rather than being tuned back down without
// live data on the new worst case.
export const maxDuration = 240;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { name, placeCategory, area, searchLocation, mode } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  const suggestion = await suggestForPlace({ name, placeCategory, area, searchLocation, mode });
  if (!suggestion) {
    return NextResponse.json({ error: "Couldn't put together a suggestion for this place. Try again." }, { status: 500 });
  }

  return NextResponse.json({ suggestion });
}
