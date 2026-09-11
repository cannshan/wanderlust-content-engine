import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// One saved search = the entire Discovery result (all three buckets) for
// one location/category combination, so it can be reopened later without
// re-running (and re-paying for) the search - same "grab what I need, no
// regeneration" idea as saved_ideas.

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved searches aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("saved_searches")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ searches: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved searches aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { location, categories, results } = body;

  if (!location || !results) {
    return NextResponse.json({ error: "location and results are both required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_searches")
    .insert({
      location,
      categories: categories?.length ? categories : ["all"],
      results,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedSearch: data });
}
