import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// Saved ideas are the full generated result for a topic (not just the
// draft input) - so "grab what I need" means the finished caption/tags/
// shot notes are already sitting there, no regeneration (and no repeat
// API cost) required. Shared across whoever has the dashboard password,
// same as the rest of this app - no per-user accounts.

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved ideas aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("saved_ideas")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ideas: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved ideas aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat, notes, lengthSeconds, platforms, results } = body;

  if (!idea || !location || !lengthSeconds || !platforms?.length || !results) {
    return NextResponse.json(
      { error: "idea, location, lengthSeconds, platforms, and results are all required." },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("saved_ideas")
    .insert({
      idea,
      location,
      story_beat: storyBeat || null,
      notes: notes || null,
      length_seconds: lengthSeconds,
      platforms,
      results,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedIdea: data });
}
