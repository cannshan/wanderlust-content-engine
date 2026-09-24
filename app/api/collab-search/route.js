import { NextResponse } from "next/server";
import { findCollabOpportunities } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Up to 6 searches plus a server-side read of each business's homepage and
// collab page - same ceiling as the other multi-search endpoints so a slow
// run isn't cut off mid-response (see the note in /api/discovery).
export const maxDuration = 240;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { location, types, focus } = body;

  if (!location || typeof location !== "string" || !location.trim()) {
    return NextResponse.json({ error: "location is required." }, { status: 400 });
  }

  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  try {
    const collabResults = await findCollabOpportunities({ location: location.trim(), types, focus });
    return NextResponse.json({ collabResults });
  } catch (err) {
    console.error("[collab-search]", err);
    return NextResponse.json({ error: err.message || "Couldn't search for collabs right now. Try again." }, { status: 500 });
  }
}
