import { NextResponse } from "next/server";
import { searchForPlace } from "../../../lib/claude";

// Powers the Planning tab's own search bar - a direct free-text lookup for
// one specific restaurant/hike/place, separate from Discovery's broad
// category search. Fires only when the user submits the search, never
// automatically.
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { query } = body;
  if (!query || !query.trim()) {
    return NextResponse.json({ error: "query is required." }, { status: 400 });
  }

  const places = await searchForPlace({ query });
  if (places === null) {
    return NextResponse.json({ error: "Couldn't search for that. Try again." }, { status: 500 });
  }

  return NextResponse.json({ places });
}
