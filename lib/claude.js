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
// max_uses capped at 1: the instructions only ever ask for a single search.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 1,
};

// Generation is split into two calls instead of one big tool call with
// every field. Live testing across many runs found a consistent pattern:
// every PLAIN STRING field here (description, hook_strategy, shot_notes as
// a delimited string, etc.) was reliable every single time. The one field
// that kept coming back missing or malformed - even after several attempted
// fixes (flattening a nested object, switching arrays to delimited strings)
// - was specifically the 5-item hashtag list. So instead of patching that
// after the fact with a conditional "repair" call, hashtags is no longer
// part of this tool at all - it's handled by a second, always-run,
// dedicated step (pickHashtags(), below) that has nothing else to do. This
// call keeps the web_search tool and produces everything BUT the final tag
// list, including a hashtag_rationale that describes the strategy/research
// findings that will guide tag selection - the actual 5 tags come from
// pickHashtags() afterward, informed by this text.
//
// video_length_seconds is left out for the same reason, but simpler: it's
// not generated at all, since it's pure arithmetic on the length the user
// already picked (resolvedLength +/- 3s - see lengthBlock() in
// voiceProfile.js, which computes the identical range for the system
// prompt text). A live log caught it coming back undefined even though
// every field around it in the schema was fine - since the model was never
// actually free to choose a different value, asking it to regenerate a
// fixed number was a pure reliability liability with no upside. Only
// video_length_why (the actual one-sentence rationale) is real generated
// content, so that's all that stays in this schema.
//
// A function of platform, not a static object, because YouTube needs one
// extra required field (title) that TikTok/Instagram don't have at all -
// title only exists in the schema for a youtube call, rather than being an
// always-present-but-sometimes-empty field on every platform.
function buildSubmitPostTool(platform) {
  const isYouTube = platform === "youtube";

  return {
    name: "submit_post",
    description: "Deliver the finished post for this platform (everything except the final hashtag list, which is handled separately). This is the only way to submit a result - call it exactly once, when every field is ready.",
    input_schema: {
      type: "object",
      properties: {
        ...(isYouTube
          ? {
              title: {
                type: "string",
                description: "The YouTube Short's title - front-load the one concrete, specific hook detail as real searchable language (a person could plausibly type it), not just a vibe or pun. This is indexed/searchable metadata on YouTube, unlike a TikTok/Instagram caption, so treat it accordingly. Roughly 40-60 characters so it doesn't get truncated.",
              },
            }
          : {}),
        description: {
          type: "string",
          description: isYouTube
            ? "The full YouTube description. Open with 1-2 lines that work as a compelling preview (what shows before a viewer taps '...more'), then expand into the fuller story/detail like her real posts, then a location/booking mention, formatted with line breaks like her real posts."
            : "The full caption, formatted with line breaks like her real posts.",
        },
        hashtag_rationale: {
          type: "string",
          description: "A neutral, plain-language summary of the HASHTAG STRATEGY for this post - not the final 5 tags themselves (those are chosen in a separate step after this). Describe the broad/niche/community mix to aim for, and if the live search or pre-fetched trend data surfaced something specifically usable, name it here and why it fits. No 'her/she' pronouns. Never write the literal words 'Source A' or 'Source B' - use a plain description instead (e.g. 'TikTok algorithm research' or 'past high-performing posts', without naming which specific past post). Keep the past-content reference general, not a detailed citation.",
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
        video_length_why: {
          type: "string",
          description: "One sentence on how this specific topic fills that fixed length well (what beats/detail it takes), and if this doesn't meet this platform's own monetization length requirement (see the length rules in the system prompt - TikTok has one, Instagram and YouTube don't), a reminder that it won't be eligible there. Neutral summary tone, no 'her/she' pronouns.",
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
        ...(isYouTube ? ["title"] : []),
        "description",
        "hashtag_rationale",
        "pattern_used",
        "hook_strategy",
        "video_length_why",
        "shot_notes",
        "cover_text",
      ],
    },
  };
}

const MAX_ATTEMPTS = 3;

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

// The dedicated, always-run hashtag step - not a conditional repair. No
// tools, no schema, one small job: read the strategy + finished caption and
// pick 5 tags. Reuses the same system prompt as the main call (voice
// formula, algorithm research, virality-pattern rules) so the tags are
// grounded in the same rules, not generic.
async function pickHashtags(apiKey, systemPrompt, prompt) {
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

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Hashtag step returned ${res.status}: ${detail.slice(0, 300)}`);
    err.nonRetryable = res.status !== 429 && res.status < 500;
    throw err;
  }

  const data = await res.json();
  const textBlock = (data?.content || []).find((b) => b.type === "text");
  return textBlock?.text?.trim() || "";
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
      // time. Only a malformed-response failure (a probabilistic glitch,
      // thrown without this flag) is worth retrying.
      if (err.nonRetryable) break;
    }
  }

  throw new Error(`${lastError.message}${lastError.nonRetryable ? "" : ` (failed after ${MAX_ATTEMPTS} attempts)`}`);
}

// One full generation attempt: the main submit_post call (description, hook,
// length, shot notes, cover text, hashtag strategy), then the always-run
// hashtag step. If either half comes back malformed, this throws and
// generatePost()'s retry loop redoes the whole attempt fresh - simpler and
// more honest than patching a broken response after the fact.
async function attemptGeneration(
  { idea, location, storyBeat, notes, liveTrends, lengthSeconds, platform },
  apiKey,
  attemptNumber
) {
  const platformLabel =
    platform === "instagram" ? "Instagram" : platform === "youtube" ? "YouTube" : "TikTok";
  const resolvedLength = lengthSeconds === 30 ? 30 : 60;

  const trendLines = (liveTrends || [])
    .map((h) => `${h.tag}${h.posts ? ` (${h.posts} posts)` : ""}`)
    .join(", ");

  const systemPrompt = buildSystemPrompt(resolvedLength, platform);

  const userPrompt = `
Platform for this package: ${platformLabel}
Topic / idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given - use your judgment based on the topic)"}
Target length: ~${resolvedLength} seconds (fixed, applies the same across platforms - see length rules in the system prompt for what this means for TikTok monetization eligibility)
Anything else to factor in (optional free text from the user - a trending hashtag/sound they spotted, an idea, a detail, anything): ${notes || "(none)"}
Pre-fetched trending hashtags for this topic (optional, use only what genuinely fits): ${
    trendLines || "(none available)"
  }

Before writing, do ONE web search for currently trending ${platformLabel} hashtags or sounds relevant to this specific topic/location (e.g. "trending ${platformLabel.toLowerCase()} hashtags [topic] 2026" or "[location] ${platformLabel.toLowerCase()} trend") to check what's live right now - unless pre-fetched trending hashtags were already given above, in which case skip the search and use those. If the user gave free-text notes above, fold whatever's relevant into the search query too (e.g. a hashtag or sound they mentioned) and weigh it heavily if it's genuinely usable. Note what you find (or don't find) in hashtag_rationale - the actual 5 tags are chosen in a separate step after this, using what you write there.

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
      // generated. Generous headroom against truncation, not a cost driver.
      max_tokens: 10000,
      system: systemPrompt,
      tools: [WEB_SEARCH_TOOL, buildSubmitPostTool(platform)],
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
  const shotNotes = parseShotNotes(input.shot_notes);

  const problems = [];
  if (platform === "youtube" && !input.title) problems.push("title is missing");
  if (!input.description) problems.push("description is missing");
  if (!input.hashtag_rationale) problems.push("hashtag_rationale is missing");
  if (shotNotes.length < 3) {
    problems.push(`shot_notes did not parse to at least 3 (got ${shotNotes.length} from: ${JSON.stringify(input.shot_notes)})`);
  }
  if (typeof input.video_length_why !== "string" || !input.video_length_why) {
    problems.push(`video_length_why is missing or malformed (got: ${JSON.stringify(input.video_length_why)})`);
  }

  if (problems.length > 0) {
    console.error(`[claude] malformed submit_post input for ${platformLabel} (attempt ${attemptNumber}):`, JSON.stringify(input).slice(0, 1500));
    throw new Error(`Claude's ${platformLabel} response was incomplete: ${problems.join("; ")}`);
  }

  // Always run - not conditional on the main call failing. This is now the
  // standard second step of every generation, since the 5-tag list was the
  // one field that kept breaking inside the bigger call.
  const hashtagPrompt = `
Topic: ${idea} at ${location}${storyBeat ? `. Story beat: ${storyBeat}` : ""}.
Pre-fetched/live trending hashtags for this topic, if any (use only what genuinely fits): ${trendLines || "(none available)"}
Anything else the user wanted factored in: ${notes || "(none)"}

The ${platformLabel} caption has already been written:

${input.description}

The hashtag strategy decided for this post: ${input.hashtag_rationale}

Do not call submit_post. Instead, following that strategy and the hashtag rules in the system prompt above (the 5-tag broad/niche/community structure, this platform's own tag conventions), respond with ONLY exactly 5 hashtags, lowercase, each starting with #, separated by commas (e.g. "#visitmaine, #acadianationalpark, #barharbor, #mainetravel, #corgisoftiktok"). No explanation, no other text - just the 5 comma-separated hashtags.
`.trim();

  const hashtagsRaw = await pickHashtags(apiKey, systemPrompt, hashtagPrompt);
  const hashtags = parseHashtags(hashtagsRaw);

  if (hashtags.length !== 5) {
    console.error(`[claude] hashtag step for ${platformLabel} (attempt ${attemptNumber}) did not yield 5 tags. Got:`, JSON.stringify(hashtagsRaw));
    throw new Error(`Claude's ${platformLabel} hashtag step did not parse to exactly 5 (got ${hashtags.length} from: ${JSON.stringify(hashtagsRaw)})`);
  }

  // Reshape video_length_why back into the nested video_length shape (paired
  // with the computed range, never model-generated - see buildSubmitPostTool()
  // above), and the delimited-string shot_notes back into an array, so the
  // rest of the app is unaffected by how these are represented in the tool
  // schema.
  const { video_length_why, shot_notes, ...rest } = input;

  return {
    ...rest,
    hashtags,
    shot_notes: shotNotes.slice(0, 5),
    video_length: {
      target_seconds: `${resolvedLength - 3}-${resolvedLength + 3}s`,
      why: video_length_why,
    },
    usedWebSearch,
  };
}
