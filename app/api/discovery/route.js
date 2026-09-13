import { NextResponse } from "next/server";
import { findDiscoveryIdeas } from "../../../lib/claude";

// Same shape as /api/nearby-ideas - opt-in, on-demand, not bundled into
// any other click - but not anchored to a primary idea. Three search
// passes (see findDiscoveryIdeas) means this can take a bit longer than
// the two-pass nearby-ideas search, especially for "all categories".
export const maxDuration = 120;

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

  const discoveryIdeas = await findDiscoveryIdeas({ location, categories, focus });
  if (!discoveryIdeas) {
    return NextResponse.json(
      { error: "Couldn't find things to do there right now. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ discoveryIdeas });
}
