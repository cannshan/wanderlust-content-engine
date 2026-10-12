import { NextResponse } from "next/server";
import { findPlaceAddress } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";
import { getSupabase } from "../../../lib/supabase";

// The map's "Find exact spot" button (PlacesMap.js): one paid search for a
// place's street address - and, from the same search, its website (for
// the card photo) - saved wherever the place lives so it's only ever
// looked up once: a planning item's own columns, or the place inside a
// saved Discovery search's results. Fires only from that button, never
// automatically.
export const maxDuration = 60;

const BUCKETS = ["popular", "interesting", "hidden"];

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { name, area, near, planningItemId, savedSearchId, bucket } = body || {};
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  const found = await findPlaceAddress({ name, area, near });
  if (found === null) {
    return NextResponse.json({ error: "Couldn't look that up. Try again." }, { status: 500 });
  }
  const { address, website } = found;
  if (!address && !website) return NextResponse.json({ address: null, website: null });

  const supabase = getSupabase();
  let item = null;

  if (supabase && planningItemId) {
    const updates = {};
    if (address) updates.address = address;
    if (website) updates.website = website;
    let { data, error } = await supabase.from("planning_items").update(updates).eq("id", planningItemId).select().single();
    // Before the website column was added (README) - keep the address.
    if (error && website && /website/i.test(error.message)) {
      delete updates.website;
      if (Object.keys(updates).length) {
        ({ data, error } = await supabase.from("planning_items").update(updates).eq("id", planningItemId).select().single());
      }
    }
    if (error) console.error("[place-address] couldn't save to planning item:", error.message);
    else item = data;
  }

  if (supabase && savedSearchId && BUCKETS.includes(bucket)) {
    const { data: saved, error } = await supabase
      .from("saved_searches")
      .select("results")
      .eq("id", savedSearchId)
      .single();
    if (!error && saved?.results?.[bucket]) {
      const results = {
        ...saved.results,
        [bucket]: saved.results[bucket].map((p) =>
          p.name === name ? { ...p, ...(address && { address }), ...(website && { website }) } : p
        ),
      };
      const { error: updateError } = await supabase
        .from("saved_searches")
        .update({ results })
        .eq("id", savedSearchId);
      if (updateError) console.error("[place-address] couldn't save to saved search:", updateError.message);
    }
  }

  return NextResponse.json({ address: address || null, website: website || null, item });
}
