import { NextResponse } from "next/server";
import { suggestStyling } from "../../../lib/claude";

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

  const stylingTip = await suggestStyling(idea, location, storyBeat);
  return NextResponse.json({ stylingTip });
}
