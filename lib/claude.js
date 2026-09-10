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
        type: "string",
        description: "Exactly 5 hashtags, lowercase, each starting with #, as ONE string separated by commas and a space - e.g. '#visitmaine, #acadianationalpark, #barharbor, #mainetravel, #corgisoftiktok'. Not a list, not one per line - a single comma-separated string.",
      },
      hashtag_rationale: {
        type: "string",
        description: "A neutral, plain-language summary of why these five tags were chosen: the broad/niche/community mix, and if a live search or pre-fetched trend surfaced one, say so and why it fits - call out anything found that could genuinely help this post specifically. No 'her/she' pronouns. Never write the literal words 'Source A' or 'Source B' - use a plain description instead (e.g. 'TikTok algorithm research' or 'past high-performing posts', without naming which specific past post). Keep the past-content reference general, not a detailed citation.",
      },
      pattern_used: {
        type: "string",
        enum: ["animal-content", "pop-culture-tie-in", "insider-access", "standard"],
        description: "Whichever proven pattern this post leans on, or 'standard' if none genuinely fit.",
      },
      hook_strategy: {
        type: "string",
        description: "1-2 sentences summarizing why this hook/description was written this way - which pattern (if any) it leans on and which algorithm mechanic is doing the real work. If research (live search or platform data) turned up something that could genuinely help this post specifically, name it here. No 'her/she' pronouns, and never the literal words 'Source A' or 'Source B' - describe them plainly instead (e.g. 'TikTok algorithm research' rather than 'Source A', 'patterns from past high-performing posts' rather than naming a specific past post).",
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
        type: "string",
        description: "3-5 short, topic-specific filming tips (what to shoot, when to hold a shot, what belongs in the opening 3 seconds to match the hook), as ONE string with each tip on its own line separated by a newline character (\\n). Not a JSON array, not numbered, not bulleted - just plain lines of text separated by newlines.",
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

// Two consecutive live failures both traced to the array-typed fields
// specifically (hashtags/shot_notes) - once missing entirely, once
// shot_notes came back as a single run-on string instead of an array, while
// every plain string field on the same call was fine. Rather than keep
// fighting that at the schema level, both fields are now plain delimited
// strings in the tool schema (see SUBMIT_POST_TOOL above) and parsed here -
// still tolerant of an actual array coming through, in case the model
// ignores the string instruction and sends one anyway.
function parseDelimitedList(value, delimiterRegex) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(delimiterRegex)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseHashtags(value) {
  let tags = parseDelimitedList(value, /,/);
  // Fallback: if no commas were used (e.g. newline or space-separated
  // instead), try splitting on whitespace before individual #tokens.
  if (tags.length < 2 && typeof value === "string") {
    const spaced = value.split(/\s+/).map((v) => v.trim()).filter(Boolean);
    if (spaced.length > tags.length) tags = spaced;
  }
  return tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
}

function parseShotNotes(value) {
  let notes = parseDelimitedList(value, /\n+/);
  // Fallback seen in testing: notes run together as one paragraph
  // separated by ". " between sentences instead of actual newlines.
  if (notes.length < 3 && typeof value === "string") {
    const bySentence = value
      .split(/\.\s+(?=[A-Z])/)
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => (v.endsWith(".") ? v : `${v}.`));
    if (bySentence.length > notes.length) notes = bySentence;
  }
  return notes;
}

// A minimal, tool-free follow-up call used only to patch a single missing
// field (see the repair logic in attemptGeneration below) - no tools, no
// schema, since the goal is maximum reliability for a small, easy task.
// It DOES reuse the same platform system prompt as the main call (voice
// formula, algorithm research, virality-pattern rules) - an earlier version
// used a bare prompt with no system message at all, which meant a repaired
// hashtag set or shot-note list skipped all of that grounding entirely and
// was just generic. Failures here are swallowed (returns null) so the
// caller falls through to the normal full-retry path.
async function repairField(apiKey, systemPrompt, prompt) {
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data?.content || []).find((b) => b.type === "text");
    return textBlock?.text?.trim() || null;
  } catch {
    return null;
  }
}

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
      // Account/auth/billing failures (bad key, no credit, rate limit) will
      // fail identically every time - retrying just wastes attempts and
      // time. Only the malformed-tool-call case (a probabilistic glitch,
      // thrown without this flag) is worth retrying.
      if (err.nonRetryable) break;
    }
  }

  throw new Error(`${lastError.message}${lastError.nonRetryable ? "" : ` (failed after ${MAX_ATTEMPTS} attempts)`}`);
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

  const systemPrompt = buildSystemPrompt(resolvedLength, platform);

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
      system: systemPrompt,
      tools: [WEB_SEARCH_TOOL, SUBMIT_POST_TOOL],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
    // 429 (rate limit) and 5xx (transient server issues) are worth
    // retrying; everything else (400 bad request/billing, 401/403
    // auth/key problems) will fail identically every time.
    err.nonRetryable = res.status !== 429 && res.status < 500;
    throw err;
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
  let hashtags = parseHashtags(input.hashtags);
  let shotNotes = parseShotNotes(input.shot_notes);

  // Targeted self-repair: if the description (the hard part) came through
  // fine but hashtags and/or shot_notes didn't, it's cheaper and more
  // reliable to patch just the missing piece with a small, tool-free,
  // single-field follow-up call than to discard a good description and
  // regenerate the whole thing from scratch via the outer retry loop.
  if (input.description) {
    // NOTE: the system prompt's own closing instruction says to call
    // submit_post - these repair prompts explicitly override that below,
    // since this call has no tools and needs a plain-text answer instead.
    if (hashtags.length !== 5) {
      console.error(`[claude] hashtags missing/malformed for ${platformLabel} (attempt ${attemptNumber}), attempting repair. Got:`, JSON.stringify(input.hashtags));
      const repaired = await repairField(
        apiKey,
        systemPrompt,
        `Topic: ${idea} at ${location}${storyBeat ? `. Story beat: ${storyBeat}` : ""}.
Pre-fetched/live trending hashtags for this topic, if any (use only what genuinely fits): ${trendLines || "(none available)"}

The ${platformLabel} caption has already been written:

${input.description}

Do not call submit_post. Instead, apply the hashtag rules from the system prompt above (the 5-tag broad/niche/community structure, this platform's own tag conventions, and the trend data above if any of it fits) and respond with ONLY exactly 5 hashtags, lowercase, each starting with #, separated by commas (e.g. "#visitmaine, #acadianationalpark, #barharbor, #mainetravel, #corgisoftiktok"). No explanation, no other text - just the 5 comma-separated hashtags.`
      );
      if (repaired) hashtags = parseHashtags(repaired);
    }
    if (shotNotes.length < 3) {
      console.error(`[claude] shot_notes missing/malformed for ${platformLabel} (attempt ${attemptNumber}), attempting repair. Got:`, JSON.stringify(input.shot_notes));
      const repaired = await repairField(
        apiKey,
        systemPrompt,
        `Topic: ${idea} at ${location}${storyBeat ? `. Story beat: ${storyBeat}` : ""}.

The ${platformLabel} caption has already been written:

${input.description}

Do not call submit_post. Instead, following the filming-notes guidance from the system prompt above (topic-specific, not generic advice, matching the hook's opening 3 seconds, shot-hold timing), give 3-5 short, concrete filming tips for shooting this exact video. Respond with ONLY the tips, one per line separated by a newline character, no numbering or bullets, no other text.`
      );
      if (repaired) shotNotes = parseShotNotes(repaired);
    }
  }

  // Seen in testing: the tool call can come back with fields silently
  // missing or malformed even though submit_post was called and no error
  // was thrown. Validate explicitly (after parsing and attempting repair
  // above) and let generatePost()'s retry loop handle anything repair
  // couldn't fix, rather than letting a partially-broken result render
  // silently in the UI.
  const problems = [];
  if (!input.description) problems.push("description is missing");
  if (hashtags.length !== 5) {
    problems.push(`hashtags did not parse to exactly 5 even after repair (got ${hashtags.length} from: ${JSON.stringify(input.hashtags)})`);
  }
  if (shotNotes.length < 3) {
    problems.push(`shot_notes did not parse to at least 3 even after repair (got ${shotNotes.length} from: ${JSON.stringify(input.shot_notes)})`);
  }
  if (typeof input.video_length_seconds !== "string" || !input.video_length_seconds) {
    problems.push(`video_length_seconds is missing or malformed (got: ${JSON.stringify(input.video_length_seconds)})`);
  }

  if (problems.length > 0) {
    console.error(`[claude] malformed submit_post input for ${platformLabel} (attempt ${attemptNumber}):`, JSON.stringify(input).slice(0, 1500));
    throw new Error(`Claude's ${platformLabel} response was incomplete: ${problems.join("; ")}`);
  }

  // Reshape the flattened video-length fields back into the nested shape,
  // and the delimited-string list fields back into arrays, so the rest of
  // the app is unaffected by how these are represented in the tool schema.
  const { video_length_seconds, video_length_why, shot_notes, ...rest } = input;

  return {
    ...rest,
    hashtags: hashtags.slice(0, 5),
    shot_notes: shotNotes.slice(0, 5),
    video_length: { target_seconds: video_length_seconds, why: video_length_why },
    usedWebSearch,
  };
}
