import { buildSystemPrompt } from "./voiceProfile";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// Claude's built-in web search tool - $0.01/search, billed to the same
// Anthropic API key already required, no separate account or login wall
// (unlike scraping TikTok's own Creative Center, which now gates keyword
// search behind a login). This is the primary "automated trend lookup" -
// Apify (lib/trends.js) is kept as an optional pre-fetch on top of it, not
// a requirement.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
};

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
Pre-fetched trending hashtags for this topic (optional, use only what genuinely fits): ${
    trendLines || "(none available)"
  }

Before writing, do ONE web search for currently trending TikTok hashtags or sounds relevant to this specific topic/location (e.g. "trending tiktok hashtags [topic] 2026" or "[location] tiktok trend") to check what's live right now - unless pre-fetched trending hashtags were already given above, in which case skip the search and use those. Only use what you find if it genuinely fits the post; never force an irrelevant trending tag just because it's popular. If the search turns up nothing useful, fall back to her proven hashtag patterns instead.

Write the post now, following the system instructions exactly. Respond with JSON only - your final message must contain ONLY the JSON object, no other text.
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
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];

  // A tool-use turn's content array holds a mix of block types (server_tool_use,
  // web_search_tool_result, text) - the final JSON is in the last text block,
  // not necessarily content[0].
  const textBlocks = blocks.filter((b) => b.type === "text");
  const text = textBlocks[textBlocks.length - 1]?.text || "";

  const usedWebSearch = blocks.some(
    (b) => b.type === "server_tool_use" && b.name === "web_search"
  );

  console.log(
    `[claude] stop_reason=${data?.stop_reason} content_blocks=${blocks.length} used_web_search=${usedWebSearch} text_len=${text.length}`
  );

  const parsed = parseJsonLoose(text, data?.stop_reason);
  return { ...parsed, usedWebSearch };
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
