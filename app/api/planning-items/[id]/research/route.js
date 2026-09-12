import { NextResponse } from "next/server";
import { getSupabase } from "../../../../../lib/supabase";
import { researchPlanningItem } from "../../../../../lib/claude";

// Fires only when the user clicks "Research this place" on a specific
// Planning tab item - never automatically. Same reasoning depth/cost as
// suggestForPlace's per-result buttons (see place-suggestion/route.js),
// so the same generous timeout.
export const maxDuration = 240;

export async function POST(req, { params }) {
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

  const { id } = await params;
  const { name, placeCategory, area, searchLocation, focus } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  const research = await researchPlanningItem({ name, placeCategory, area, searchLocation, focus });
  if (!research) {
    return NextResponse.json({ error: "Couldn't put together research for this place. Try again." }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("planning_items")
    .update({ research, researched_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}
