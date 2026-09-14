import { NextResponse } from "next/server";
import { writeVoiceoverFromReel } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// The video itself never reaches this route - the client extracts a
// handful of small JPEG frames in-browser (see lib/videoFrames.js) and
// only sends those, so this stays well under Vercel's request body limit
// without needing any server-side video processing.
export const maxDuration = 120;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { frames, durationSeconds, idea, location, notes, platform } = body;

  if (!Array.isArray(frames) || frames.length === 0) {
    return NextResponse.json({ error: "No video frames were provided." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  try {
    const result = await writeVoiceoverFromReel({ frames, durationSeconds, idea, location, notes, platform });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
