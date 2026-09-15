import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Sets (or clears, with category: null / plannedDate: null) either or both
// of a saved idea's simple editable fields - category (the free-text
// organizational tag - see the "Categorize" button in ContentTab.js; no
// separate categories table, same "create it by using it" model as most
// tagging UIs) and plannedDate (which calendar day this idea is scheduled
// for, see PlanningCalendar.js as used from ContentTab). Only updates
// whichever field is actually present in the body - a plain "category" in
// body check, not `typeof body.category === "string"` alone, since the
// latter would silently wipe an idea's category to null on every
// plannedDate-only request (undefined isn't a string), and vice versa for
// plannedDate.
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
  const updates = {};
  if ("category" in body) {
    updates.category = typeof body.category === "string" ? body.category.trim().slice(0, 60) || null : null;
  }
  if ("plannedDate" in body) {
    // A plain "YYYY-MM-DD" string (an <input type="date">'s native value)
    // or null to clear - never a full timestamp, since an idea is
    // scheduled for a day, not a specific time.
    updates.planned_date = typeof body.plannedDate === "string" && body.plannedDate ? body.plannedDate : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_ideas")
    .update(updates)
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
