import { NextResponse } from "next/server";
import { checkRestaurantMenu } from "../../../lib/claude";

// A dedicated endpoint so the menu check - which doesn't vary by platform,
// unlike the trend search which deliberately does - runs exactly once per
// "Generate" click instead of once per selected platform. page.js calls
// this first and passes the result into each /api/generate request, which
// otherwise would run this same live search redundantly for every
// platform generating the same restaurant/bar post.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, notes } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  const menuCheck = await checkRestaurantMenu(idea, location, storyBeat, notes);
  return NextResponse.json({ menuCheck });
}
