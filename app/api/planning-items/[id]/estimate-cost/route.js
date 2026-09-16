import { NextResponse } from "next/server";
import { getSupabase } from "../../../../../lib/supabase";
import { estimateItemCost } from "../../../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../../../lib/budget";

// Fires only when the user clicks "Estimate cost" on a specific Planning
// tab item - never automatically. Same shape as .../research: a real
// Claude call grounded in a live search, its result persisted straight
// onto the item's own row rather than held as ephemeral state, so it
// survives a refresh and is there for the Trip Calendar's per-day totals
// to sum (see CalendarTab.js) without re-asking every time.
export async function POST(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Planning isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
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
  const { name, placeCategory, area, searchLocation } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  const estimate = await estimateItemCost({ name, placeCategory, area, searchLocation });
  if (!estimate) {
    return NextResponse.json(
      { error: "Couldn't find real pricing for this place. Try again." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("planning_items")
    .update({
      estimated_cost_usd: estimate.costUsd,
      estimated_cost_note: estimate.note || null,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ item: data });
}
