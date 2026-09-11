import { NextResponse } from "next/server";
import { suggestForPlace } from "../../../lib/claude";

// Ad-hoc only - fires when a user clicks one of the three per-place
// buttons in DiscoveryTab (Clothes to Wear / Foodie-Explore Advice /
// Suggest Both), never automatically for every place in a result.
// 180 -> 240: findStyleLinks (lib/claude.js) can now run up to 2 retry
// search rounds on top of the initial call when it hasn't found 3 verified
// clothing images yet, so worst case is a few sequential Claude calls
// chained together, not just one.
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

  const suggestion = await suggestForPlace({ name, placeCategory, area, searchLocation, mode });
  if (!suggestion) {
    return NextResponse.json({ error: "Couldn't put together a suggestion for this place. Try again." }, { status: 500 });
  }

  return NextResponse.json({ suggestion });
}
