import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Sets (or clears, with category: null) the free-text category tag on a
// saved idea - see the "Categorize" button in ContentTab.js. There's no
// separate categories table; a category only exists in the sense that
// some saved idea currently has that string in its category column -
// same "create it by using it" model as most tagging UIs (Gmail labels,
// etc.), so there's nothing to keep in sync if a category is renamed or
// every idea using it gets deleted.
export async function PATCH(req, { params }) {
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

  const { id } = await params;
  const category = typeof body.category === "string" ? body.category.trim().slice(0, 60) || null : null;

  const { data, error } = await supabase
    .from("saved_ideas")
    .update({ category })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ savedIdea: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Saved ideas aren't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { id } = await params;
  const { error } = await supabase.from("saved_ideas").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
