import { buildSystemPrompt } from "./voiceProfile";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

export async function generatePost({
  idea,
  location,
  storyBeat,
  businessTag,
  format,
  trendNotes,
  liveTrends,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md)."
    );
  }

  const trendLines = (liveTrends || [])
    .map((h) => `${h.tag}${h.posts ? ` (${h.posts} posts)` : ""}`)
    .join(", ");

  const userPrompt = `
Topic / idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given - use your judgment based on the topic)"}
Business or venue to tag: ${businessTag || "(none given - omit the @handle line)"}
Preferred format: ${format === "itinerary" ? "emoji-bullet itinerary list" : "narrative story"}
Manually-spotted trend (optional): ${trendNotes || "(none)"}
Live trending hashtags fetched for this topic (optional, use only what genuinely fits): ${
    trendLines || "(none available)"
  }

Write the post now, following the system instructions exactly. Respond with JSON only.
`.trim();

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  // Sonnet's response can include non-text blocks (e.g. thinking) before the
  // text block - don't assume content[0] is the one we want.
  const textBlock = (data?.content || []).find((b) => b.type === "text");
  const text = textBlock?.text || "";

  console.log(
    `[claude] stop_reason=${data?.stop_reason} content_blocks=${data?.content?.length} text_len=${text.length}`
  );

  return parseJsonLoose(text, data?.stop_reason);
}

// Claude is instructed to return strict JSON, but strips fences defensively
// in case a model response wraps it in ```json anyway. On failure, the raw
// text is logged server-side AND included in the thrown message (truncated)
// so it surfaces directly in the dashboard's error banner - no separate log
// access needed to diagnose a bad response.
function parseJsonLoose(text, stopReason) {
  const cleaned = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    console.error("[claude] no JSON braces found in response:", text);
    throw new Error(
      `Claude did not return parseable JSON (stop_reason: ${stopReason}). Raw response: ${
        text.slice(0, 500) || "(empty)"
      }`
    );
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    console.error("[claude] JSON.parse failed on:", cleaned);
    throw new Error(
      `Claude's response wasn't valid JSON (stop_reason: ${stopReason}, parse error: ${err.message}). Raw response: ${cleaned.slice(
        0,
        500
      )}`
    );
  }
}
