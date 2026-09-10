import { NextResponse } from "next/server";
import { findLocationTagOptions } from "../../../lib/claude";

// Same reasoning as /api/menu-check: a dedicated endpoint so this live
// search runs exactly once per "Generate" click instead of once per
// selected platform. Unlike the menu check, this isn't conditional on
// topic type - almost every post has a real location worth checking - so
// page.js calls it unconditionally alongside the menu check, in parallel.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { idea, location, storyBeat } = body;

  if (!idea || !location) {
    return NextResponse.json(
      { error: "Idea and location are both required." },
      { status: 400 }
    );
  }

  const locationContext = await findLocationTagOptions(idea, location, storyBeat);
  return NextResponse.json({ locationContext });
}
