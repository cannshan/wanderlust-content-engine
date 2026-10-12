import { NextResponse } from "next/server";
import { getSupabase } from "../../../../../lib/supabase";
import { researchPlanningItem } from "../../../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../../../lib/budget";

// Fires only when the user clicks "Research this place" on a specific
// Planning tab item - never automatically. Same reasoning depth/cost as
// suggestForPlace's per-result buttons (see place-suggestion/route.js),
// so the same generous timeout.
export const maxDuration = 240;

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
  const { name, placeCategory, area, searchLocation, focus, menuLinks, menuFiles, plannedDate } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  const trimmedMenuLinks = (Array.isArray(menuLinks) ? menuLinks : [])
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter(Boolean);

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  const research = await researchPlanningItem({
    name,
    placeCategory,
    area,
    searchLocation,
    focus,
    menuLinks: trimmedMenuLinks,
    menuFiles,
    plannedDate,
  });
  if (!research) {
    return NextResponse.json({ error: "Couldn't put together research for this place. Try again." }, { status: 500 });
  }

  const { address, website, ...researchFields } = research;
  let { data, error } = await supabase
    .from("planning_items")
    .update({
      research: researchFields,
      researched_at: new Date().toISOString(),
      // Menu links persist on the item (like a saved idea's own menu
      // links) so they don't need retyping next time - the uploaded
      // file itself never does, same "only ever used inline for the one
      // request that reads it" rule as everywhere else in this app.
      menu_links: trimmedMenuLinks.length ? trimmedMenuLinks : null,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // A street address (map pin) or website (card photo) the research's
  // searches turned up fills a gap on the item - never overwrites one
  // already saved (e.g. from "Find exact spot"). Best-effort: a missing
  // column (README) or a filled field just leaves the item as it is.
  for (const [column, value] of [["address", address], ["website", website]]) {
    if (!value || data[column]) continue;
    const filled = await supabase
      .from("planning_items")
      .update({ [column]: value })
      .eq("id", id)
      .is(column, null)
      .select()
      .maybeSingle();
    if (filled.data) data = filled.data;
  }

  return NextResponse.json({ item: data });
}
