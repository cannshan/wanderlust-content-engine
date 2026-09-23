import { NextResponse } from "next/server";
import { refinePost } from "../../../lib/claude";
import { checkBudget, BUDGET_LIMIT_MESSAGE } from "../../../lib/budget";

// "Tweak this" on the Content tab: edits one platform's already-generated
// post according to Leah's plain-language feedback, reusing the research
// the original generation already did (sent back in `context`) instead of
// searching again - see refinePost in lib/claude.js.
export const maxDuration = 120;

const MAX_FEEDBACK_CHARS = 2000;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { platform, lengthSeconds, current, feedback, priorFeedback, context } = body;
  const trimmedFeedback = typeof feedback === "string" ? feedback.trim().slice(0, MAX_FEEDBACK_CHARS) : "";

  if (!trimmedFeedback) {
    return NextResponse.json({ error: "Say what you'd like changed first." }, { status: 400 });
  }
  if (!current?.description) {
    return NextResponse.json({ error: "There's no generated post to tweak." }, { status: 400 });
  }

  // Not currently enforced - see the identical comment in /api/discovery.
  const budget = await checkBudget();
  if (!budget.ok) {
    return NextResponse.json({ error: BUDGET_LIMIT_MESSAGE }, { status: 429 });
  }

  try {
    const result = await refinePost({
      platform,
      lengthSeconds,
      current,
      feedback: trimmedFeedback,
      priorFeedback: Array.isArray(priorFeedback) ? priorFeedback.slice(-10) : [],
      context,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
