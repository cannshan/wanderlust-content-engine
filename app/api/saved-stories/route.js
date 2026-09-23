import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// The Stories tab's "Saved stories" sidebar - same idea as saved ideas on
// the Content tab: a planned set of story slides (the paid part - cuts,
// lines, text positions) kept so it can be reopened later without paying
// to plan it again. The reel itself is never stored (it never leaves the
// browser); reopening a saved plan asks for the same reel again to make
// the clips. Each slide carries a small preview thumbnail instead of the
// full-size sampled frames.

const NOT_CONFIGURED =
  "Saved stories aren't set up yet - run the saved_stories SQL from README.md in Supabase.";

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 500 });

  const { data, error } = await supabase
    .from("saved_stories")
    .select("*")
    .order("created_at", { ascending: false });

  // A missing table (the SQL in README.md hasn't been run yet) shows the
  // plain setup message instead of Supabase's schema-cache error.
  if (error) {
    const missingTable = /could not find the table|does not exist/i.test(error.message);
    return NextResponse.json({ error: missingTable ? NOT_CONFIGURED : error.message }, { status: 500 });
  }
  return NextResponse.json({ stories: data });
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

  const { title, idea, location, notes, sourceFile, durationSeconds, sceneSummary, slides } = body;
  if (!title || !Array.isArray(slides) || slides.length === 0) {
    return NextResponse.json({ error: "title and at least one slide are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_stories")
    .insert({
      title: String(title).slice(0, 200),
      idea: idea || null,
      location: location || null,
      notes: notes || null,
      source_file: sourceFile || null,
      duration_seconds: Number(durationSeconds) || null,
      scene_summary: Array.isArray(sceneSummary) ? sceneSummary : null,
      slides,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ story: data });
}
