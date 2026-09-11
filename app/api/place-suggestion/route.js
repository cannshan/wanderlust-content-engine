import { NextResponse } from "next/server";
import { suggestForPlace } from "../../../lib/claude";

// Ad-hoc only - fires when a user clicks one of the three per-place
// buttons in DiscoveryTab (Clothes to Wear / Foodie-Explore Advice /
// Suggest Both), never automatically for every place in a result.
export const maxDuration = 180;

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
