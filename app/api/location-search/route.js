import { NextResponse } from "next/server";
import { findLocationTagOptions } from "../../../lib/claude";
import { checkBudget } from "../../../lib/budget";

// Same reasoning as /api/restaurant-check: a dedicated endpoint so this
// live search runs exactly once per "Generate" click instead of once per
// selected platform. Unlike the restaurant check, this isn't conditional
// on topic type or a checkbox - almost every post has a real location
// worth checking - so page.js calls it unconditionally, in parallel with
// the restaurant check (when that one applies).
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
  // reason - it just quietly comes back empty, no error surfaced.
  const budget = await checkBudget();
  if (!budget.ok) return NextResponse.json({ locationContext: null });

  const locationContext = await findLocationTagOptions(idea, location, storyBeat);
  return NextResponse.json({ locationContext });
}
