import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Updates a saved story's category (the sidebar's Categorize button, via
// useCategorizedItems) and/or its slides (edits made to a reopened story's
// lines or text positions, so the saved copy stays the latest version).
// Only fields actually present in the body are touched - same rule as
// /api/ideas/[id].
export async function PATCH(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: "Saved stories aren't set up yet." }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id } = await params;
  const updates = {};
  if ("category" in body) {
    updates.category = typeof body.category === "string" ? body.category.trim().slice(0, 60) || null : null;
  }
  if ("slides" in body) {
    if (!Array.isArray(body.slides)) {
      return NextResponse.json({ error: "slides must be an array." }, { status: 400 });
    }
    updates.slides = body.slides;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { data, error } = await supabase.from("saved_stories").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ story: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: "Saved stories aren't set up yet." }, { status: 500 });

  const { id } = await params;
  const { error } = await supabase.from("saved_stories").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
