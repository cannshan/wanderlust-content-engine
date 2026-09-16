import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// Plain "post this on this day" entries for the Calendar tab: a title and
// a date, nothing else. These exist for content that's already made and
// just needs scheduling - the app has nothing to generate, research or
// store for it, so putting it through saved_ideas would mean a content
// record with no content in it, cluttering the Content tab's sidebar with
// rows that can't be opened into anything. A separate table keeps a
// scheduling note a scheduling note.
//
// Deliberately not the same thing as a saved idea with a planned_date:
// that's a real generated package that also happens to be scheduled. Both
// show up on the calendar; only these are editable there.

const NOT_CONFIGURED = {
  error: "The calendar isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing).",
};

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json(NOT_CONFIGURED, { status: 500 });

  const { data, error } = await supabase
    .from("calendar_items")
    .select("*")
    .order("planned_date", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json(NOT_CONFIGURED, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  // A plain "YYYY-MM-DD" string (an <input type="date">'s native value),
  // never a full timestamp - same reasoning as planned_date everywhere
  // else here: this is planned FOR a day, not for a time.
  const plannedDate = typeof body.plannedDate === "string" && body.plannedDate ? body.plannedDate : "";

  if (!title) return NextResponse.json({ error: "title is required." }, { status: 400 });
  if (!plannedDate) return NextResponse.json({ error: "plannedDate is required." }, { status: 400 });

  const { data, error } = await supabase
    .from("calendar_items")
    .insert({ title, planned_date: plannedDate })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}
