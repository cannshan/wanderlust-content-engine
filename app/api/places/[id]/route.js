import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Sets (or clears, with category: null) the free-text organizational tag
// on a saved place - see the "Categorize" button in DiscoveryTab.js. Same
// "create it by using it" model as saved ideas' categories (see
// app/api/ideas/[id]/route.js) - no separate categories table.
export async function PATCH(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved places aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
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
  const category = typeof body.category === "string" ? body.category.trim().slice(0, 60) || null : null;

  const { data, error } = await supabase
    .from("saved_places")
    .update({ category })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedPlace: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved places aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { id } = await params;
  const { error } = await supabase.from("saved_places").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
