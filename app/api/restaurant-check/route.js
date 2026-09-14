import { NextResponse } from "next/server";
import { analyzeRestaurant } from "../../../lib/claude";
import { checkBudget } from "../../../lib/budget";

// Replaces /api/menu-check's old auto-detect-and-search approach. This one
// only ever gets called when the user has explicitly checked "Restaurant"
// in the form and given a restaurant name (page.js skips this fetch
// entirely otherwise - not even a detection probe, unlike before).
// Platform-agnostic (a menu doesn't change based on which app it's posted
// to), so - same as /api/menu-check always was - this runs once per
// "Generate" click and gets shared across every selected platform's
// request instead of each one repeating the same read/search.
//
// Request body size note: menuFiles (uploaded menu photos/PDFs) are sent
// as base64, which runs ~33% larger than the original files. Vercel's
// serverless request body limit is a hard ceiling here - ContentTab.js
// caps the combined original files at 4MB client-side to stay safely
// under it.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { restaurantName, location, idea, storyBeat, menuLinks, menuFiles } = body;

  if (!restaurantName) {
    return NextResponse.json({ error: "restaurantName is required." }, { status: 400 });
  }

  // Silently returns null on a budget block, same as this optional
  // pre-fetch already does whenever the real call fails for any other
  // reason - see the identical comment in /api/location-search.
  const budget = await checkBudget();
  if (!budget.ok) return NextResponse.json({ restaurantContext: null });

  const restaurantContext = await analyzeRestaurant({
    restaurantName,
    location,
    idea,
    storyBeat,
    menuLinks,
    menuFiles,
  });

  return NextResponse.json({ restaurantContext });
}
