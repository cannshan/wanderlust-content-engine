import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Sets (or clears, with category: null) a saved voiceover's category - the
// sidebar's Categorize button, via useCategorizedItems.
export async function PATCH(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: "Saved voiceovers aren't set up yet." }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!("category" in body)) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { id } = await params;
  const category = typeof body.category === "string" ? body.category.trim().slice(0, 60) || null : null;
  const { data, error } = await supabase.from("saved_voiceovers").update({ category }).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ voiceover: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: "Saved voiceovers aren't set up yet." }, { status: 500 });

  const { id } = await params;
  const { error } = await supabase.from("saved_voiceovers").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
