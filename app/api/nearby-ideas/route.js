import { NextResponse } from "next/server";
import { findNearbyFilmingIdeas } from "../../../lib/claude";

// Deliberately separate from /api/generate - this only runs when the user
// explicitly asks for it (see the "Find nearby ideas" button in page.js,
// shown once a result already exists), not bundled into every Generate
// click. findNearbyFilmingIdeas() does up to 5 searches in one call, so
// it's worth more time than the other pre-fetch endpoints but still opt-in.
export const maxDuration = 120;

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

  const nearbyIdeas = await findNearbyFilmingIdeas({ idea, location, storyBeat, categories });
  if (!nearbyIdeas) {
    return NextResponse.json(
      { error: "Couldn't find nearby filming ideas right now. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ nearbyIdeas });
}
