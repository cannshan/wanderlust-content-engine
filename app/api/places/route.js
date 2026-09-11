import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// One saved place = one specific spot pulled out of a Discovery/nearby-
// ideas result (see the Save button next to each place in DiscoveryTab).
// Deliberately separate from saved_searches - a creator building a life
// list of specific spots to visit/film wants to browse and tag those
// individually, not re-open a whole multi-place search result every time.

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved places aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("saved_places")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ places: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved places aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { name, placeCategory, area, why, angle, bucket, searchLocation, foodSuggestion, styleSuggestion, styleLinks } = body;

  if (!name || !bucket || !searchLocation) {
    return NextResponse.json({ error: "name, bucket, and searchLocation are all required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_places")
    .insert({
      name,
      place_category: placeCategory || null,
      area: area || null,
      why: why || null,
      angle: angle || null,
      bucket,
      search_location: searchLocation,
      // Whichever ad-hoc suggestions (see the per-place buttons in
      // DiscoveryTab) had already been generated at the moment this place
      // was saved - null if the user never clicked those buttons for it.
      // Not retroactively fetched here; only carries along what already
      // existed in the browser.
      food_suggestion: foodSuggestion || null,
      style_suggestion: styleSuggestion || null,
      style_links: styleLinks?.length ? styleLinks : null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedPlace: data });
}
