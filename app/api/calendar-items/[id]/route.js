import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

const NOT_CONFIGURED = {
  error: "The calendar isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing).",
};

// Moves a calendar note to a different day, renames it, or marks it
// completed. Only updates whichever field is actually present in the body
// - the same `"x" in body` check the planning-items and saved-ideas PATCH
// routes use, for the same reason: keying off the value's type alone
// would silently wipe the other fields on every single-field request
// (e.g. a drag-to-reschedule sending only plannedDate would otherwise
// read completed as absent-and-false and un-complete the note).
export async function PATCH(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json(NOT_CONFIGURED, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id } = await params;
  const updates = {};

  if ("title" in body) {
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
    if (!title) return NextResponse.json({ error: "title can't be empty." }, { status: 400 });
    updates.title = title;
  }

  if ("plannedDate" in body) {
    // Unlike a saved idea's planned_date, this can't be cleared to null -
    // a calendar note with no date has nowhere to live, so clearing one
    // is a delete (see below), not an update.
    const plannedDate = typeof body.plannedDate === "string" && body.plannedDate ? body.plannedDate : "";
    if (!plannedDate) return NextResponse.json({ error: "plannedDate can't be empty." }, { status: 400 });
    updates.planned_date = plannedDate;
  }

  if ("completed" in body) {
    updates.completed = !!body.completed;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("calendar_items")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json(NOT_CONFIGURED, { status: 500 });

  const { id } = await params;
  const { error } = await supabase.from("calendar_items").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
