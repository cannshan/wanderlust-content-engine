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

const PLATFORM_PACKAGE_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "The full caption for this platform, formatted with line breaks like her real posts. Shares the same core hook/story as the other platform's package, but the CTA line must match this platform's top engagement signal (see system prompt).",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      minItems: 5,
      maxItems: 5,
      description: "Exactly 5 hashtags, lowercase, each starting with #, tailored to this platform's own community-tag conventions (e.g. #corgisoftiktok vs #corgisofinstagram).",
    },
    hashtag_rationale: {
      type: "string",
      description: "Why these five tags for this platform specifically: the broad/niche/community mix and, if a live search or pre-fetched trend was used, which tag came from that and why it fits.",
    },
    video_length: {
      type: "object",
      properties: {
        content_type: { type: "string", enum: ["entertainment", "practical", "story"] },
        target_seconds: {
          type: "string",
          description: "A specific target or narrow range inside that type's window, per this platform's length rules in the system prompt.",
        },
        why: {
          type: "string",
          description: "One sentence tying the target to this specific post's content and this platform's rules.",
        },
      },
      required: ["content_type", "target_seconds", "why"],
    },
    shot_notes: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 5,
      description: "Short, topic-specific filming/export tips for this platform - what to shoot, when to hold a shot, what belongs in the opening 3 seconds, and any platform-specific export note (e.g. Instagram: export with no TikTok watermark).",
    },
    cover_text: {
      type: "string",
      description: "Short bold cover/thumbnail text built around the hook's specific detail, under 8 words, respecting this platform's safe zone.",
    },
  },
  required: ["description", "hashtags", "hashtag_rationale", "video_length", "shot_notes", "cover_text"],
};

// A previous version asked Claude to reply with raw JSON text and hand-parsed
// it by finding the outer { }. Live testing showed that's unreliable once
// web_search is in the mix - Claude sometimes stopped writing before all
// fields were filled in (a valid-looking but incomplete object, so it
// parsed "successfully" while silently missing fields). Forcing the result
// through a tool call with a strict input_schema is Anthropic's recommended
// structured-output pattern and makes every field here actually required.
const SUBMIT_POST_TOOL = {
  name: "submit_post",
  description: "Deliver the finished post for both platforms. This is the only way to submit a result - call it exactly once, when every field is ready.",
  input_schema: {
    type: "object",
    properties: {
      pattern_used: {
        type: "string",
        enum: ["animal-content", "pop-culture-tie-in", "insider-access", "standard"],
        description: "Whichever Source B lever this post leans on (shared across both platforms), or 'standard' if none genuinely fit.",
      },
      hook_strategy: {
        type: "string",
        description: "1-2 sentences citing BOTH which Source B lever (if any) this hook uses, and which Source A mechanic is doing the real work - the shared core idea behind both platform packages.",
      },
      cross_post_warning: {
        type: "string",
        description: "A short, specific reminder (not generic) about exporting clean footage for Instagram if the same video is being posted to both platforms - reference the watermark/Originality Score penalty from the system prompt.",
      },
      platforms: {
        type: "object",
        properties: {
          tiktok: PLATFORM_PACKAGE_SCHEMA,
          instagram: PLATFORM_PACKAGE_SCHEMA,
        },
        required: ["tiktok", "instagram"],
      },
    },
    required: ["pattern_used", "hook_strategy", "cross_post_warning", "platforms"],
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
  goal,
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
Goal for the TikTok package specifically: ${goal === "reach" ? "maximize reach/growth - length has no floor, shortest length that still earns 70%+ completion wins, even knowing it may not be TikTok-monetizable" : "monetize on TikTok - 60s minimum, non-negotiable"} (Instagram always uses its own no-floor length rules regardless of this goal, per the system prompt)
Manually-spotted trend (optional): ${trendNotes || "(none)"}
Pre-fetched trending hashtags for this topic (optional, use only what genuinely fits): ${
    trendLines || "(none available)"
  }

Before writing, do ONE web search for currently trending hashtags or sounds relevant to this specific topic/location on TikTok and/or Instagram (e.g. "trending tiktok hashtags [topic] 2026" or "[location] instagram reels trend") to check what's live right now - unless pre-fetched trending hashtags were already given above, in which case skip the search and use those. Only use what you find if it genuinely fits the post; never force an irrelevant trending tag just because it's popular. If the search turns up nothing useful, fall back to her proven hashtag patterns instead.

Write the TikTok and Instagram packages now, following the system instructions exactly, then call submit_post with the complete result.
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
      // Two full platform packages roughly doubles the output versus the
      // single-platform version that previously needed 4096 with headroom.
      max_tokens: 6144,
      system: buildSystemPrompt(goal),
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
