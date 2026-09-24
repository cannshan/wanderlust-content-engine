import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// One saved collab search = the whole Collab Search result for an area, so
// it can be reopened without re-running (and re-paying for) the search -
// same idea as saved_searches for Discovery.

const NOT_CONFIGURED =
  "Saved collab searches aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing, or the saved_collab_searches table hasn't been created - see README.md).";

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 500 });

  const { data, error } = await supabase
    .from("saved_collab_searches")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ searches: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { location, types, focus, results } = body;

  if (!location || !results) {
    return NextResponse.json({ error: "location and results are both required." }, { status: 400 });
  }

  const trimmedFocus = typeof focus === "string" ? focus.trim() : "";

  const { data, error } = await supabase
    .from("saved_collab_searches")
    .insert({
      location,
      types: types?.length ? types : ["all"],
      focus: trimmedFocus || null,
      results,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedSearch: data });
}
