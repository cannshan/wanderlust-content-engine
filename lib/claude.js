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

// A previous version asked Claude to reply with raw JSON text and hand-parsed
// it by finding the outer { }. Live testing showed that's unreliable once
// web_search is in the mix - Claude sometimes stopped writing before all
// fields were filled in (a valid-looking but incomplete object, so it
// parsed "successfully" while silently missing video_length/shot_notes/
// cover_text). Forcing the result through a tool call with a strict
// input_schema is Anthropic's recommended structured-output pattern and
// makes every field here actually required, not just requested in prose.
const SUBMIT_POST_TOOL = {
  name: "submit_post",
  description: "Deliver the finished post. This is the only way to submit a result - call it exactly once, when every field is ready.",
  input_schema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "The full caption, formatted with line breaks like her real posts.",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        minItems: 5,
        maxItems: 5,
        description: "Exactly 5 hashtags, lowercase, each starting with #.",
      },
      hashtag_rationale: {
        type: "string",
        description: "Why these five tags: the broad/niche/community mix (Source A) and, if a live search or pre-fetched trend was used, which tag came from that and why it fits.",
      },
      pattern_used: {
        type: "string",
        enum: ["animal-content", "pop-culture-tie-in", "insider-access", "standard"],
        description: "Whichever Source B lever this post leans on, or 'standard' if none genuinely fit.",
      },
      hook_strategy: {
        type: "string",
        description: "1-2 sentences citing BOTH which Source B lever (if any) this hook uses, and which Source A mechanic is doing the real work.",
      },
      video_length: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["entertainment", "practical", "story"] },
          target_seconds: {
            type: "string",
            description: "A specific target or narrow range inside that type's window, e.g. '22-28s', not the full window restated.",
          },
          why: {
            type: "string",
            description: "One sentence tying the target to this specific post's content.",
          },
        },
        required: ["content_type", "target_seconds", "why"],
      },
      shot_notes: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 5,
        description: "Short, topic-specific filming tips - what to shoot, when to hold a shot, what belongs in the opening 3 seconds to match the hook.",
      },
      cover_text: {
        type: "string",
        description: "Short bold cover/thumbnail text built around the hook's specific detail, under 8 words.",
      },
    },
    required: [
      "description",
      "hashtags",
      "hashtag_rationale",
      "pattern_used",
      "hook_strategy",
      "video_length",
      "shot_notes",
      "cover_text",
    ],
  },
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

Write the post now, following the system instructions exactly, then call submit_post with the complete result.
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
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: [WEB_SEARCH_TOOL, SUBMIT_POST_TOOL],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];

  const usedWebSearch = blocks.some(
    (b) => b.type === "server_tool_use" && b.name === "web_search"
  );

  const submitBlock = blocks.find(
    (b) => b.type === "tool_use" && b.name === "submit_post"
  );

  console.log(
    `[claude] stop_reason=${data?.stop_reason} content_blocks=${blocks.length} used_web_search=${usedWebSearch} got_submit_post=${!!submitBlock}`
  );

  if (!submitBlock) {
    // Fall back to scanning for stray text in case the model ignored the
    // tool instruction, so a mis-behaving turn still surfaces something
    // diagnosable instead of a bare "no result" error.
    const textBlocks = blocks.filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n");
    console.error("[claude] no submit_post tool call in response:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude did not call submit_post (stop_reason: ${data?.stop_reason}). ${
        text ? `It said instead: ${text.slice(0, 500)}` : "No text content either - see server logs."
      }`
    );
  }

  return { ...submitBlock.input, usedWebSearch };
}
