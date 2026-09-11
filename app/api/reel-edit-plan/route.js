import { NextResponse } from "next/server";
import { writeReelEditPlan } from "../../../lib/claude";

// Same shape as /api/reel-voiceover - frames only, never the raw video
// files themselves, so this stays well under Vercel's request body limit
// no matter how many clips were uploaded (see the per-clip frame-budget
// scaling in ReelVoiceoverTab.js). The actual cutting/stitching happens
// afterward, client-side, via lib/assembleReel.js - this route only
// produces the plan. Raised from 120s: up to 20 clips means more images
// to review and a larger plan to write, so this can legitimately run
// longer than the original few-clip case.
export const maxDuration = 240;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { clips, idea, location, notes, platform } = body;

  if (!Array.isArray(clips) || clips.length === 0) {
    return NextResponse.json({ error: "No clips were provided." }, { status: 400 });
  }

  try {
    const result = await writeReelEditPlan({ clips, idea, location, notes, platform });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
