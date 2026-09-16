import { NextResponse } from "next/server";
import { describeReelFootage } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Reads an already-filmed reel and reports what's actually in it, so the
// Content tab can ground the caption/title/cover text in the real video
// instead of the idea typed before filming. Runs once per "Generate"
// click and its result is shared across every platform's request - the
// same pre-fetch-and-share pattern as /api/restaurant-check and
// /api/location-search, since what's on screen doesn't change based on
// which app the video is being posted to.
//
// Like /api/reel-voiceover, the video itself never reaches this route:
// the client extracts a handful of small JPEG frames in-browser (see
// lib/videoFrames.js) and only sends those, so this stays well under
// Vercel's request body limit with no server-side video processing.
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { frames, durationSeconds, idea, location, notes } = body;

  if (!Array.isArray(frames) || frames.length === 0) {
    return NextResponse.json({ error: "No video frames were provided." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  try {
    const result = await describeReelFootage({ frames, durationSeconds, idea, location, notes });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
