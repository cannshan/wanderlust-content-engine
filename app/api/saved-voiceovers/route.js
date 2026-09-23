import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// The Reel Voiceover tab's "Saved voiceovers" sidebar - same idea as saved
// ideas on the Content tab: a written voiceover script (and the footage
// rundown it was written from) kept so it can be reopened later without
// paying to write it again. The video itself is never stored - in "raw
// clips" mode the assembled reel only ever exists in the browser that
// made it.

const NOT_CONFIGURED =
  "Saved voiceovers aren't set up yet - run the saved_voiceovers SQL from README.md in Supabase.";

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 500 });

  const { data, error } = await supabase
    .from("saved_voiceovers")
    .select("*")
    .order("created_at", { ascending: false });

  // A missing table (the SQL in README.md hasn't been run yet) shows the
  // plain setup message instead of Supabase's schema-cache error.
  if (error) {
    const missingTable = /could not find the table|does not exist/i.test(error.message);
    return NextResponse.json({ error: missingTable ? NOT_CONFIGURED : error.message }, { status: 500 });
  }
  return NextResponse.json({ voiceovers: data });
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

  const { title, mode, idea, location, notes, platform, sceneSummary, voiceoverScript, totalDurationSeconds } = body;
  if (!title || !voiceoverScript) {
    return NextResponse.json({ error: "title and voiceoverScript are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_voiceovers")
    .insert({
      title: String(title).slice(0, 200),
      mode: mode === "assemble" ? "assemble" : "single",
      idea: idea || null,
      location: location || null,
      notes: notes || null,
      platform: platform || null,
      scene_summary: Array.isArray(sceneSummary) ? sceneSummary : null,
      voiceover_script: voiceoverScript,
      total_duration_seconds: Number(totalDurationSeconds) || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ voiceover: data });
}
