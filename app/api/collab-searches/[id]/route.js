import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

const NOT_CONFIGURED =
  "Saved collab searches aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing, or the saved_collab_searches table hasn't been created - see README.md).";

// Two kinds of update: { category } (same tagging as every other saved
// list) and { results } (a lead's outreach status changed, or "Find more"
// added leads to a search that was already saved).
export async function PATCH(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id } = await params;
  const update = {};
  if ("category" in body) {
    update.category = typeof body.category === "string" ? body.category.trim().slice(0, 60) || null : null;
  }
  if (body.results && typeof body.results === "object") {
    update.results = body.results;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_collab_searches")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedSearch: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 500 });

  const { id } = await params;
  const { error } = await supabase.from("saved_collab_searches").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
