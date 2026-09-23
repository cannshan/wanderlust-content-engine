import { NextResponse } from "next/server";
import { planStoriesFromReel } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// Plans how a finished reel gets cut into Instagram Story slides and what
// short line goes on each one. Like /api/reel-footage, the video itself
// never reaches this route - the Stories tab extracts small JPEG frames
// in-browser (lib/videoFrames.js) and only sends those; the actual cutting
// and text overlay happen client-side afterward (lib/storyClips.js).
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
    const result = await planStoriesFromReel({ frames, durationSeconds, idea, location, notes });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
