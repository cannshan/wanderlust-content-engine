import { buildSystemPrompt } from "./voiceProfile";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// Claude's built-in web search tool - $0.01/search, billed to the same
// Anthropic API key already required, no separate account or login wall
// (unlike scraping TikTok's own Creative Center, which now gates keyword
// search behind a login). This is the primary "automated trend lookup" -
// Apify (lib/trends.js) is kept as an optional pre-fetch on top of it, not
// a requirement.
//
// max_uses capped at 1 (was 3): the instructions only ever ask for a single
// search, and the extra agentic round-trips a higher cap allowed seemed to
// correlate with the malformed-tool-call failures below - fewer steps
// before the final submit_post call, less surface area for it to break.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 1,
};

// A previous version asked Claude to reply with raw JSON text and hand-parsed
// it by finding the outer { }. Live testing showed that's unreliable once
// web_search is in the mix - Claude sometimes stopped writing before all
// fields were filled in. Forcing the result through a tool call with a
// strict input_schema is Anthropic's recommended structured-output pattern
// and makes every field here actually required.
//
// A dual-platform version of this (one call producing both TikTok and
// Instagram packages together) was tried and reverted - the combined
// generation + two web searches routinely exceeded Vercel's function
// timeout. Generating one platform per call and running both in parallel
// from the client (see app/page.js) is both faster and more reliable.
const SUBMIT_POST_TOOL = {
  name: "submit_post",
  description: "Deliver the finished post for this platform. This is the only way to submit a result - call it exactly once, when every field is ready.",
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
        description: "A neutral summary of why these five tags were chosen: the broad/niche/community mix, and if a live search or pre-fetched trend surfaced one of them, say so and why it fits. No 'her/she' pronouns - write like an analyst explaining a decision, not a note about Leah. Reference Wine Wilderness Wanderlust's past content as one input among others (platform research, live search results), not the sole reason.",
      },
      pattern_used: {
        type: "string",
        enum: ["animal-content", "pop-culture-tie-in", "insider-access", "standard"],
        description: "Whichever proven Wine Wilderness Wanderlust pattern this post leans on, or 'standard' if none genuinely fit.",
      },
      hook_strategy: {
        type: "string",
        description: "1-2 sentences summarizing why this hook/description was written this way - which proven pattern (if any) it leans on and which platform-research mechanic is doing the real work. No 'her/she' pronouns - write as a neutral summary of the decision (e.g. 'Wine Wilderness Wanderlust's past posts show...' or 'this matches research showing...'), not a note about Leah personally.",
      },
      video_length_seconds: {
        type: "string",
        description: "A tight range around the user's chosen fixed length (e.g. '57-63s' for a 60s target), per the length rules in the system prompt.",
      },
      video_length_why: {
        type: "string",
        description: "One sentence on how this specific topic fills that fixed length well (what beats/detail it takes), and if under 60s on TikTok, a reminder that it won't be monetization-eligible. Neutral summary tone, no 'her/she' pronouns.",
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
      "video_length_seconds",
      "video_length_why",
      "shot_notes",
      "cover_text",
    ],
  },
};

const MAX_ATTEMPTS = 3;

export async function generatePost(params) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md)."
    );
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await attemptGeneration(params, apiKey, attempt);
      return result;
    } catch (err) {
      lastError = err;
      console.error(
        `[claude] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${params.platform}: ${err.message}`
      );
    }
  }

  throw new Error(`${lastError.message} (failed after ${MAX_ATTEMPTS} attempts)`);
}

// A single generation attempt - the malformed-tool-call failures seen in
// testing (missing hashtags/shot_notes, or a corrupted video_length value)
// are probabilistic, not deterministic, so the reliable fix is retrying a
// fresh generation rather than trying to prompt-engineer around a one-off
// glitch. generatePost() above wraps this in a retry loop.
async function attemptGeneration(
  { idea, location, storyBeat, notes, liveTrends, lengthSeconds, platform },
  apiKey,
  attemptNumber
) {
  const platformLabel = platform === "instagram" ? "Instagram" : "TikTok";
  const resolvedLength = lengthSeconds === 30 ? 30 : 60;

  const trendLines = (liveTrends || [])
    .map((h) => `${h.tag}${h.posts ? ` (${h.posts} posts)` : ""}`)
    .join(", ");

  const userPrompt = `
Platform for this package: ${platformLabel}
Topic / idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given - use your judgment based on the topic)"}
Target length: ~${resolvedLength} seconds (fixed, applies the same on both platforms - see length rules in the system prompt for what this means for TikTok monetization eligibility)
Anything else to factor in (optional free text from the user - a trending hashtag/sound they spotted, an idea, a detail, anything): ${notes || "(none)"}
Pre-fetched trending hashtags for this topic (optional, use only what genuinely fits): ${
    trendLines || "(none available)"
  }

Before writing, do ONE web search for currently trending ${platformLabel} hashtags or sounds relevant to this specific topic/location (e.g. "trending ${platformLabel.toLowerCase()} hashtags [topic] 2026" or "[location] ${platformLabel.toLowerCase()} trend") to check what's live right now - unless pre-fetched trending hashtags were already given above, in which case skip the search and use those. If the user gave free-text notes above, fold whatever's relevant into the search query too (e.g. a hashtag or sound they mentioned) and weigh it heavily if it's genuinely usable. Only use what you find if it genuinely fits the post; never force an irrelevant trending tag just because it's popular. If the search turns up nothing useful, fall back to her proven hashtag patterns instead.

Write the ${platformLabel} post now, following the system instructions exactly, then call submit_post with the complete result.
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
      // A ceiling, not a target - only billed for what's actually
      // generated. Real generations run 1500-3000 tokens; this is
      // generous headroom against truncation, not an expected cost driver.
      max_tokens: 10000,
      system: buildSystemPrompt(resolvedLength, platform),
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
    `[claude] platform=${platform} attempt=${attemptNumber} stop_reason=${data?.stop_reason} content_blocks=${blocks.length} used_web_search=${usedWebSearch} got_submit_post=${!!submitBlock}`
  );

  if (!submitBlock) {
    // Fall back to scanning for stray text in case the model ignored the
    // tool instruction, so a mis-behaving turn still surfaces something
    // diagnosable instead of a bare "no result" error.
    const textBlocks = blocks.filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n");
    console.error("[claude] no submit_post tool call in response:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude did not call submit_post for ${platformLabel} (stop_reason: ${data?.stop_reason}). ${
        text ? `It said instead: ${text.slice(0, 500)}` : "No text content either - see server logs."
      }`
    );
  }

  const input = submitBlock.input || {};

  // Seen in testing: the tool call can come back with fields silently
  // missing or malformed (e.g. hashtags/shot_notes absent, or a value
  // containing a stray tool-syntax fragment) even though submit_post was
  // called and no error was thrown. Validate explicitly and let
  // generatePost()'s retry loop handle it rather than letting a
  // partially-broken result render silently in the UI.
  const problems = [];
  if (!input.description) problems.push("description is missing");
  if (!Array.isArray(input.hashtags) || input.hashtags.length !== 5) {
    problems.push(`hashtags is missing or not exactly 5 (got: ${JSON.stringify(input.hashtags)})`);
  }
  if (!Array.isArray(input.shot_notes) || input.shot_notes.length < 3) {
    problems.push(`shot_notes is missing or too short (got: ${JSON.stringify(input.shot_notes)})`);
  }
  if (typeof input.video_length_seconds !== "string" || !input.video_length_seconds) {
    problems.push(`video_length_seconds is missing or malformed (got: ${JSON.stringify(input.video_length_seconds)})`);
  }

  if (problems.length > 0) {
    console.error(`[claude] malformed submit_post input for ${platformLabel} (attempt ${attemptNumber}):`, JSON.stringify(input).slice(0, 1500));
    throw new Error(`Claude's ${platformLabel} response was incomplete: ${problems.join("; ")}`);
  }

  // Reshape the flattened video-length fields back into the nested shape
  // the rest of the app expects - flattened in the tool schema itself
  // because the nested-object version was the specific thing that came
  // back malformed in testing.
  const { video_length_seconds, video_length_why, ...rest } = input;

  return {
    ...rest,
    video_length: { target_seconds: video_length_seconds, why: video_length_why },
    usedWebSearch,
  };
}
