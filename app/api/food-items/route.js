import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// One saved food item = one specific dish/drink pulled out of a Foodie/
// Explore Advice result (see the Save button on each food-item card in
// DiscoveryTab). Deliberately separate from saved_places - someone
// building a "dishes to try" list wants to browse/tag those individually,
// not dig back through a whole saved place to find which one had the
// good lobster roll.

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved items aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("saved_food_items")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved items aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { name, price, source, imageUrl, placeName, searchLocation } = body;

  if (!name || !searchLocation) {
    return NextResponse.json({ error: "name and searchLocation are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_food_items")
    .insert({
      name,
      price: price || null,
      source: source || null,
      image_url: imageUrl || null,
      place_name: placeName || null,
      search_location: searchLocation,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedItem: data });
}
