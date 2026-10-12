import { NextResponse } from "next/server";
import { geocodePlaces } from "../../../lib/geocode";

// Coordinates for the Discovery/Planning map pins (see lib/geocode.js -
// free OpenStreetMap lookups, no Claude call, no cost). The client sends
// places in small batches so pins appear progressively instead of after
// one long wait: Nominatim allows one lookup per second, and each place
// can take up to three (its area, then two name queries) the first time.
export const maxDuration = 60;

const MAX_PLACES_PER_REQUEST = 8;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const places = Array.isArray(body?.places) ? body.places : [];
  if (places.length === 0 || places.length > MAX_PLACES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Send between 1 and ${MAX_PLACES_PER_REQUEST} places.` },
      { status: 400 }
    );
  }

  const cleaned = places.map((p) => ({
    name: String(p?.name || "").slice(0, 200),
    area: p?.area ? String(p.area).slice(0, 200) : null,
    near: p?.near ? String(p.near).slice(0, 200) : null,
  }));
  if (cleaned.some((p) => !p.name)) {
    return NextResponse.json({ error: "Every place needs a name." }, { status: 400 });
  }

  const results = await geocodePlaces(cleaned);
  return NextResponse.json({ results });
}
