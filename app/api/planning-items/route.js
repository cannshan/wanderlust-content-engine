import { NextResponse } from "next/server";
import { PLACE_KINDS } from "../../../lib/placeLinks";
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

  const { name, placeCategory, placeKind, area, why, angle, bucket, searchLocation, category, address, website } = body;

  if (!name || !searchLocation) {
    return NextResponse.json({ error: "name and searchLocation are required." }, { status: 400 });
  }

  const row = {
    name,
    place_category: placeCategory || null,
    // venue/event/outdoors/experience, from the search that found it -
    // decides whether its name links to Google Maps or a Google search
    // (lib/placeLinks.js).
    place_kind: PLACE_KINDS.includes(placeKind) ? placeKind : null,
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
    // The street address the search that found this place saw, if any -
    // only used to pin it exactly on the Planning map (lib/geocode.js).
    address: typeof address === "string" && address.trim() ? address.trim().slice(0, 200) : null,
    // Its own website, if the search saw one - only used to show the
    // site's preview photo on the place's card (/api/place-images).
    website: typeof website === "string" && /^https?:\/\//i.test(website.trim()) ? website.trim().slice(0, 300) : null,
  };

  let { data, error } = await supabase.from("planning_items").insert(row).select().single();
  // Before the address/website/place_kind columns were added (README) -
  // drop whichever one the database doesn't have and save the place anyway.
  for (const column of ["place_kind", "website", "address"]) {
    if (!error || !new RegExp(column, "i").test(error.message)) continue;
    delete row[column];
    ({ data, error } = await supabase.from("planning_items").insert(row).select().single());
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}
