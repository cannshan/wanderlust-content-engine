import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// One planning item = one place moved over from a Discovery result via
// "Add to Planning" (see DiscoveryTab.js). Separate from saved_places -
// saved_places is a life list to browse/tag, planning_items is the working
// set of places actually being planned around, each with its own
// deep-dive research (see /api/planning-items/[id]/research) attached
// directly to the row.

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Planning isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("planning_items")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Planning isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { name, placeCategory, area, why, angle, bucket, searchLocation, category } = body;

  if (!name || !searchLocation) {
    return NextResponse.json({ error: "name and searchLocation are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("planning_items")
    .insert({
      name,
      place_category: placeCategory || null,
      area: area || null,
      why: why || null,
      angle: angle || null,
      bucket: bucket || null,
      search_location: searchLocation,
      // The organizational category the user picks in the "Add to
      // Planning" flow (or types fresh, right there) - same "create it by
      // using it" model as saved_places' category, no separate categories
      // table. Optional: left null lands the item as uncategorized, still
      // assignable later via the Categorize button in the Planning tab.
      category: category || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}
